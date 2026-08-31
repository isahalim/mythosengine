import Database from "better-sqlite3";
import { drizzle as drizzleBetterSqlite3, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzleD1, type DrizzleD1Database } from "drizzle-orm/d1";
import type { SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";
import { WorkerBatchClient } from "./worker-batch.ts";
import * as schema from "./schema.ts";

/**
 * Local/test client only, backed by better-sqlite3. Production reads/writes
 * go through D1 — either a Worker binding, or (from the GitHub Actions
 * pipeline runner, which has no Worker binding available) the D1 HTTP API
 * via db/d1-http.ts's createD1HttpDb, using this same `schema.ts`.
 */
export function createTestDb(path: string = ":memory:") {
  const client = new Database(path);
  client.pragma("foreign_keys = ON");
  return { client, db: drizzleBetterSqlite3(client, { schema }) };
}

/** Production client: wraps the Worker's D1 binding with the same schema. */
export function createD1Db(d1: D1Database): DrizzleD1Database<typeof schema> {
  return drizzleD1(d1, { schema });
}

/**
 * Every Phase 8 service function (src/server/console/**) and every pipeline
 * stage accepts this union rather than one concrete dialect, so the same
 * function runs against a real D1 binding in production, the D1 HTTP client
 * from the GitHub Actions pipeline runner, and a better-sqlite3-backed test
 * DB in tests (schema.test.ts already establishes this split; this is that
 * same split applied to query-builder code instead of raw SQL). Only chain
 * shapes common to all three dialects (select/insert/update/delete,
 * awaited) are used — dialect-specific result shapes (D1Result vs.
 * RunResult vs. sqlite-proxy's SqliteRemoteResult) are never inspected by
 * shared code.
 */
export type AppDb = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema> | SqliteRemoteDatabase<typeof schema>;

/**
 * Single-row read for `AppDb`. **Use this instead of drizzle's `.get()`.**
 *
 * `.get()` is not portable across the three dialects this codebase runs on.
 * Over the D1 HTTP client (db/d1-http.ts, the GitHub Actions arm), a query
 * matching no rows hands drizzle's sqlite-proxy dialect an empty array, and
 * `mapGetResult` only short-circuits on a *falsy* `rows` — `[]` is truthy,
 * so it builds a row object with every field `undefined` instead of
 * returning `undefined`. A miss therefore comes back **truthy**, and every
 * `if (!row) return null` guard in this codebase silently stopped working
 * the moment the pipeline moved to D1-over-HTTP.
 *
 * That was not theoretical: RENDER failed on every scheduled run from
 * 2026-08-29 to 2026-08-31 with `"undefined" is not valid JSON`, because
 * `getSettings` passed a ghost row's `compiledJson` to `JSON.parse`. That
 * one was loud. The others — an unmatched credential, an unmatched MCP
 * token, an unmatched export — were not.
 *
 * The proxy callback cannot express "no row" without lying to drizzle's
 * declared `rows: any[]` type, so the fix is here rather than there: `.all()`
 * maps an empty result to `[]` identically on all three dialects, and
 * indexing it gives a real `undefined`.
 */
export async function getOne<T>(query: { all: () => T[] | Promise<T[]> }): Promise<T | undefined> {
  // `T[] | Promise<T[]>` because the dialects genuinely differ: better-sqlite3
  // is synchronous and the two D1 arms are not. Awaiting covers both.
  const rows = await query.all();
  return rows[0];
}

/** The underlying binding/connection beneath AppDb — needed only for execAtomic below. */
export type RawSqlClient = D1Database | Database.Database | WorkerBatchClient;

function isWorkerBatchClient(client: RawSqlClient): client is WorkerBatchClient {
  return client instanceof WorkerBatchClient;
}

function isD1Client(client: RawSqlClient): client is D1Database {
  return !isWorkerBatchClient(client) && typeof (client as D1Database).batch === "function";
}

/**
 * Runs several parameterized statements as one atomic unit (CLAUDE.md:
 * never a multi-step mutation outside a transaction), for the rare
 * genuinely-multi-statement write that can't be collapsed into one SQL
 * statement the way db/footage-select.ts's claimNextFootageSegment or
 * src/server/console/settings.ts's activateDraft can. D1's `.batch()` and
 * better-sqlite3's native `.transaction()` are each dialect's own real
 * atomicity primitive — drizzle's `.transaction()` wrapper is deliberately
 * not used here; its callback signature differs enough between the D1
 * (async) and better-sqlite3 (sync) dialects that a single callback can't
 * be typed against both at once (see settings.ts's activateDraft comment
 * for the same friction on a different method).
 */
export async function execAtomic(client: RawSqlClient, statements: { sql: string; params: unknown[] }[]): Promise<void> {
  // Outside the Worker: hand the batch to the Worker, which holds the real
  // D1 binding. D1's REST API cannot do parameterized *and* multi-statement
  // in one call, so there is no local equivalent to fall back to — see
  // db/worker-batch.ts.
  if (isWorkerBatchClient(client)) {
    await client.batch(statements);
    return;
  }
  if (isD1Client(client)) {
    await client.batch(statements.map((s) => client.prepare(s.sql).bind(...s.params)));
    return;
  }
  const run = client.transaction(() => {
    for (const s of statements) client.prepare(s.sql).run(...(s.params as (string | number | bigint | null)[]));
  });
  run();
}
