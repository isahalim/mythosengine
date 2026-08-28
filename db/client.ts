import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.ts";

/**
 * Local/test client only, backed by better-sqlite3. Production reads/writes
 * go through D1 (via a Worker binding, or the D1 HTTP API from the GitHub
 * Actions runner — see ARCHITECTURE.md §0), using this same `schema.ts`.
 */
export function createTestDb(path: string = ":memory:") {
  const client = new Database(path);
  client.pragma("foreign_keys = ON");
  return { client, db: drizzle(client, { schema }) };
}
