import Database from "better-sqlite3";
import { drizzle as drizzleBetterSqlite3, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzleD1, type DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./schema.ts";

/**
 * Local/test client only, backed by better-sqlite3. Production reads/writes
 * go through D1 (via a Worker binding, or the D1 HTTP API from the GitHub
 * Actions runner — see ARCHITECTURE.md §0), using this same `schema.ts`.
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
 * Every Phase 8 service function (src/server/console/**) accepts this union
 * rather than one concrete dialect, so the same function runs against a real
 * D1 binding in production and a better-sqlite3-backed test DB in tests
 * (schema.test.ts already establishes this split; this is that same split
 * applied to query-builder code instead of raw SQL). Only chain shapes
 * common to both dialects (select/insert/update/delete, awaited) are used —
 * dialect-specific result shapes (D1Result vs. RunResult) are never
 * inspected by shared code.
 */
export type AppDb = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>;

/** The underlying binding/connection beneath AppDb — needed only for execAtomic below. */
export type RawSqlClient = D1Database | Database.Database;

function isD1Client(client: RawSqlClient): client is D1Database {
  return typeof (client as D1Database).batch === "function";
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
  if (isD1Client(client)) {
    await client.batch(statements.map((s) => client.prepare(s.sql).bind(...s.params)));
    return;
  }
  const run = client.transaction(() => {
    for (const s of statements) client.prepare(s.sql).run(...(s.params as (string | number | bigint | null)[]));
  });
  run();
}
