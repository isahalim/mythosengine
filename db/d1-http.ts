import { drizzle } from "drizzle-orm/sqlite-proxy";
import type { SqliteRemoteDatabase, AsyncRemoteCallback } from "drizzle-orm/sqlite-proxy";
import { fetchWithRetry } from "../src/lib/drivers/http.ts";
import * as schema from "./schema.ts";

/**
 * D1-over-HTTP: the only way GitHub Actions (plain Node, no Worker binding)
 * can reach D1. Cloudflare's own current docs steer external callers toward
 * a proxy Worker instead of this REST endpoint directly ("D1's built-in
 * REST API is best suited for administrative use as the global Cloudflare
 * API rate limit applies" — developers.cloudflare.com/d1/tutorials/
 * build-an-api-to-access-d1/, checked 2026-08-28). Deliberately not
 * followed here: this pipeline issues on the order of a few dozen D1
 * queries per run (hourly WATCH, 3x/day RENDER, weekly FOOTAGE REFRESH) —
 * nowhere near the account-wide API rate limit — and a proxy Worker would
 * mean minting and guarding a second, more powerful bearer credential
 * (arbitrary SQL execution against the live database) for marginal benefit
 * at this volume. `CLOUDFLARE_API_TOKEN` already has D1 Edit scope
 * (PROVISIONED.md) and is already the credential GitHub Actions uses for KV
 * writes (KvExportDriver) — reusing it here adds no new secret. Revisit if
 * this project ever actually hits Cloudflare's global API rate limit.
 *
 * Endpoint/response shape confirmed against Cloudflare's current docs
 * (Prepared Statements / D1Result: developers.cloudflare.com/d1/worker-api/
 * prepared-statements/), not guessed: `POST /accounts/:account_id/d1/
 * database/:database_id/query` with `{ sql, params }`, returning the
 * standard Cloudflare API envelope `{ success, errors, messages, result }`
 * where `result` is an array of per-statement `{ success, meta, results }`
 * objects — `results` being an array of column-keyed row objects (matching
 * the same `{success, result, errors}` envelope shape KvExportDriver
 * already documents for the sibling KV REST API).
 */
export interface D1HttpOptions {
  accountId: string;
  databaseId: string;
  apiToken: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
}

interface CloudflareD1QueryResult {
  results?: Record<string, unknown>[];
  success?: boolean;
}

interface CloudflareApiEnvelope {
  success?: boolean;
  result?: CloudflareD1QueryResult[];
  errors?: { code?: number; message?: string }[];
}

function isCloudflareApiEnvelope(value: unknown): value is CloudflareApiEnvelope {
  return typeof value === "object" && value !== null;
}

/** One raw `sql`+`params` round trip against the D1 REST endpoint. Throws on any failure — sqlite-proxy's callback contract has no separate error channel. */
async function queryD1Http(options: Required<Pick<D1HttpOptions, "accountId" | "databaseId" | "apiToken">> & D1HttpOptions, sql: string, params: unknown[]): Promise<CloudflareD1QueryResult> {
  const baseUrl = options.baseUrl ?? "https://api.cloudflare.com/client/v4";
  const url = `${baseUrl}/accounts/${options.accountId}/d1/database/${options.databaseId}/query`;

  const result = await fetchWithRetry(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${options.apiToken}` },
      body: JSON.stringify({ sql, params }),
    },
    {
      timeoutMs: options.timeoutMs ?? 30_000,
      maxAttempts: options.maxAttempts ?? 3,
      baseDelayMs: options.baseDelayMs ?? 500,
      fetchImpl: options.fetchImpl,
    },
  );

  if (!result.ok) {
    throw new Error(`D1 HTTP request failed: [${result.error.kind}] ${result.error.message}`);
  }

  let body: unknown;
  try {
    body = await result.value.json();
  } catch (cause) {
    throw new Error(`D1 HTTP response was not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }

  if (!isCloudflareApiEnvelope(body) || body.success !== true) {
    const errors = isCloudflareApiEnvelope(body) ? body.errors : undefined;
    const message = errors?.map((e) => `[${e.code ?? "?"}] ${e.message ?? "unknown error"}`).join("; ") || "D1 HTTP query reported success: false";
    throw new Error(message);
  }

  return body.result?.[0] ?? { results: [] };
}

/**
 * `sqlite-proxy`'s remote callback: D1 returns rows as column-keyed
 * objects, but the proxy dialect wants positional value arrays (it
 * reconstructs objects itself using the query's own field metadata).
 * `Object.values` preserves D1/SQLite's select-list column order.
 * `"get"` wants a single row's values as the top-level array (not wrapped
 * in another array) — confirmed against drizzle-orm's own
 * `sqlite-proxy/session.js` (`mapGetResult` treats `rows` itself as the
 * row), not assumed.
 */
function makeCallback(options: D1HttpOptions): AsyncRemoteCallback {
  return async (sql, params, method) => {
    const queryResult = await queryD1Http(options as Required<Pick<D1HttpOptions, "accountId" | "databaseId" | "apiToken">> & D1HttpOptions, sql, params);
    const results = queryResult.results ?? [];
    if (method === "get") {
      return { rows: results.length > 0 ? Object.values(results[0]) : [] };
    }
    return { rows: results.map((row) => Object.values(row)) };
  };
}

export function createD1HttpDb(options: D1HttpOptions): SqliteRemoteDatabase<typeof schema> {
  return drizzle(makeCallback(options), { schema });
}

/**
 * `RawSqlClient`'s HTTP arm for `execAtomic` (db/client.ts). D1's REST
 * `/query` endpoint's transactional guarantee for a single multi-statement
 * `sql` string isn't spelled out the way `D1Database::batch`'s is
 * ("Batched statements are SQL transactions... aborts/rolls back the
 * entire sequence" — developers.cloudflare.com/d1/worker-api/d1-database/)
 * — so this wraps the statements in explicit `BEGIN`/`COMMIT` and sends
 * them as one HTTP call (same D1 session, real SQL transaction semantics
 * either way), with every `?` renumbered to a globally unique `?N` so
 * per-statement placeholder numbering can't collide across the combined
 * string. Not exercised against a live D1 database in this session unless
 * noted otherwise in docs/DECISIONS.md — treat as unverified until then.
 */
export class D1HttpRawClient {
  constructor(private readonly options: D1HttpOptions) {}

  async batch(statements: { sql: string; params: unknown[] }[]): Promise<void> {
    let counter = 0;
    const allParams: unknown[] = [];
    const renumbered = statements.map((s) => {
      const sql = s.sql.replace(/\?/g, () => {
        counter++;
        return `?${counter}`;
      });
      allParams.push(...s.params);
      return sql;
    });

    const combinedSql = ["BEGIN;", ...renumbered.map((s) => `${s.trim().replace(/;\s*$/, "")};`), "COMMIT;"].join("\n");
    await queryD1Http(this.options as Required<Pick<D1HttpOptions, "accountId" | "databaseId" | "apiToken">> & D1HttpOptions, combinedSql, allParams);
  }
}
