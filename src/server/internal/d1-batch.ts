import { execAtomic, type AppDb, type RawSqlClient } from "../../../db/client.ts";
import { writeAuditLog } from "../audit.ts";
import { log } from "../log.ts";
import { secretsMatch } from "./shared-secret.ts";
import { err, ok, type Result } from "../../lib/result.ts";

/**
 * Caps on one batch. Not tuning knobs — a request past any of these is not a
 * legitimate pipeline write, and refusing it cheaply is the point. The
 * largest real caller (`seed-sources.ts`) sends one statement per source row.
 */
export const MAX_STATEMENTS = 64;
export const MAX_SQL_BYTES = 200_000;
export const MAX_PARAMS = 2_048;

export interface D1BatchStatement {
  sql: string;
  params: unknown[];
}

/**
 * Validates the request body into statements, or says exactly what is wrong.
 *
 * Everything crossing this boundary is untrusted, so the shape is checked
 * rather than asserted: this endpoint executes SQL against production, and a
 * cast here would be the whole security model quietly opting out.
 */
export function parseBatchBody(value: unknown): Result<D1BatchStatement[], string> {
  if (typeof value !== "object" || value === null) return err("body must be a JSON object");
  const { statements } = value as { statements?: unknown };
  if (!Array.isArray(statements)) return err("body.statements must be an array");
  if (statements.length === 0) return err("body.statements is empty");
  if (statements.length > MAX_STATEMENTS) return err(`body.statements has ${statements.length} entries, over the ${MAX_STATEMENTS} limit`);

  const parsed: D1BatchStatement[] = [];
  let totalSqlBytes = 0;
  let totalParams = 0;

  for (const [index, entry] of statements.entries()) {
    if (typeof entry !== "object" || entry === null) return err(`statements[${index}] must be an object`);
    const { sql, params } = entry as { sql?: unknown; params?: unknown };
    if (typeof sql !== "string" || sql.trim().length === 0) return err(`statements[${index}].sql must be a non-empty string`);
    if (!Array.isArray(params)) return err(`statements[${index}].params must be an array`);

    totalSqlBytes += sql.length;
    totalParams += params.length;
    if (totalSqlBytes > MAX_SQL_BYTES) return err(`combined SQL exceeds ${MAX_SQL_BYTES} bytes`);
    if (totalParams > MAX_PARAMS) return err(`combined parameters exceed ${MAX_PARAMS}`);

    parsed.push({ sql, params });
  }

  return ok(parsed);
}

/** SQL text is audit-worthy; bound parameters are the payload and are never recorded. Truncated because an audit row is evidence of *what ran*, not a second copy of the query. */
function describeStatements(statements: D1BatchStatement[]): string[] {
  return statements.map((s) => s.sql.replace(/\s+/g, " ").trim().slice(0, 120));
}

export interface D1BatchDeps {
  db: AppDb;
  rawClient: RawSqlClient;
  /** The shared secret from the Worker's own environment. Empty or unset means this endpoint is closed. */
  pipelineBatchToken: string | undefined;
}

/**
 * `POST /internal/d1/batch` — runs several parameterized statements as one
 * atomic D1 transaction on behalf of the GitHub Actions pipeline.
 *
 * **Why this endpoint exists.** `execAtomic` is how this codebase honours
 * CLAUDE.md's "never perform a multi-step database mutation outside a
 * transaction". Inside the Worker that is `D1Database.batch()`, which is a
 * real transaction. From the Actions runner there was no equivalent: D1's
 * REST `/query` endpoint accepts *either* several statements *or* bound
 * parameters, never both (`7400: params with multiple statements is not
 * supported`, confirmed against the live database 2026-08-31), and exposes
 * no batch primitive at all. That broke every multi-statement write from the
 * pipeline, `generateScript` included, so SCRIPT could not persist and the
 * pipeline could not reach RENDER.
 *
 * The three ways out were: inline the parameters as escaped literals (throws
 * away parameterization — a SQL-injection footgun aimed at our own script
 * text), give up atomicity (forbidden), or send the batch to the one place
 * that already has the real primitive. This is the third. The Worker holds
 * the D1 *binding*, so `execAtomic` here dispatches to `.batch()` and both
 * properties — parameterized and atomic — survive the trip.
 *
 * **What guards it.** A dedicated bearer secret compared in constant time,
 * fail-closed when unset (an unconfigured deployment refuses rather than
 * opens), hard caps on batch size, and an audit row per call. This is
 * deliberately a narrow surface with a real key on it: it can run arbitrary
 * SQL, which is exactly why the token is its own secret, shared with nothing
 * else, and why every call is written down.
 */
export async function handleD1Batch(request: Request, deps: D1BatchDeps): Promise<Response> {
  const expected = deps.pipelineBatchToken;
  if (expected === undefined || expected.length === 0) {
    // Fail closed, and say which variable is missing without ever printing
    // its value (CLAUDE.md). A deployment that forgot the secret must not
    // silently accept anonymous SQL.
    log.error({ event: "d1_batch.unconfigured" }, "PIPELINE_BATCH_TOKEN is not set on this Worker — refusing every internal batch request.");
    return Response.json({ error: "not_configured" }, { status: 503 });
  }

  const authorization = request.headers.get("authorization");
  if (authorization === null || !authorization.startsWith("Bearer ")) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!(await secretsMatch(authorization.slice("Bearer ".length), expected))) {
    log.warn({ event: "d1_batch.rejected" }, "Internal batch request presented a token that did not match.");
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = parseBatchBody(body);
  if (!parsed.ok) return Response.json({ error: "invalid_request", detail: parsed.error }, { status: 400 });

  const operations = describeStatements(parsed.value);
  try {
    await execAtomic(deps.rawClient, parsed.value);
  } catch (cause) {
    // The caller is a headless pipeline whose only evidence is a CI log, so
    // the database's own explanation goes back over the wire rather than
    // being flattened into "500". Three separate failures this month were
    // prolonged by exactly that kind of discarded message.
    const detail = cause instanceof Error ? cause.message : String(cause);
    log.error({ event: "d1_batch.failed", statements: parsed.value.length, detail }, "Internal batch failed.");
    return Response.json({ error: "batch_failed", detail }, { status: 500 });
  }

  await writeAuditLog(deps.db, "pipeline", "d1.batch", `${parsed.value.length} statement(s)`, { operations });
  log.info({ event: "d1_batch.ok", statements: parsed.value.length }, "Internal batch committed.");
  return Response.json({ ok: true, statements: parsed.value.length });
}
