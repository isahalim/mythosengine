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

/*
 * `D1HttpRawClient` used to live here — `execAtomic`'s HTTP arm, wrapping
 * its statements in `BEGIN; …; COMMIT;` with a combined `params` array. It
 * was deleted on 2026-08-30 because it cannot be made to work: D1's REST
 * `/query` endpoint answers `7400: The request is malformed: params with
 * multiple statements is not supported`. The endpoint takes either several
 * statements or bound parameters, never both, and offers no equivalent of
 * the Worker binding's atomic `.batch()`.
 *
 * Deleted rather than left throwing: a class that compiles, type-checks and
 * fails only against the live database is a trap, and this one had already
 * cost a month of scheduled RENDERs. Multi-statement writes from outside the
 * Worker now go through `db/worker-batch.ts`, which sends them to the one
 * process that holds the real binding. Single-statement reads still use
 * `createD1HttpDb` above, which needs no transaction and works fine.
 */
