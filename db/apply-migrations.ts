import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";

const MIGRATIONS_DIR = join(import.meta.dirname, "migrations");

/** Applies every committed migration file, in order, to a fresh test DB. */
export function applyMigrations(client: Database.Database): void {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed.length > 0) client.exec(trimmed);
    }
  }
}
