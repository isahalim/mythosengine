import { parse } from "yaml";
import { sources } from "../../../db/schema.ts";
import { execAtomic, type AppDb, type RawSqlClient } from "../../../db/client.ts";

interface SourcesFile {
  sources: { id: string; kind: string; url: string; enabled?: boolean }[];
}

const VALID_KINDS = new Set(["reddit", "rss", "x", "youtube_community"]);

function isSourcesFile(value: unknown): value is SourcesFile {
  return (
    typeof value === "object" &&
    value !== null &&
    "sources" in value &&
    Array.isArray((value as { sources: unknown }).sources)
  );
}

/**
 * Idempotently seeds `sources` from data/sources.yml — safe to re-run;
 * existing rows are left untouched.
 *
 * Called by scripts/pipeline/watch.ts on every hourly run, deliberately, not
 * once by hand: this function was written and unit-tested in Phase 3 but
 * never wired to anything, so production's `sources` table sat empty and
 * WATCH polled nothing. The pipeline reported no failure for it — there was
 * genuinely nothing to poll — and the console honestly showed zero signals.
 * Seeding on every run makes the table's contents a consequence of the
 * committed YAML rather than of someone having remembered to run a command.
 *
 * Typed against AppDb (all three dialects), and never inspects a driver's
 * result shape for a `changes` count — which dialect-agnostic code cannot do
 * (db/client.ts's AppDb contract) — so "what's already there" is read first
 * and the inserts are derived from that. The inserts go through execAtomic
 * as one batch: CLAUDE.md's "never a multi-step database mutation outside a
 * transaction" applies to seeding too.
 */
export async function seedSourcesFromYaml(db: AppDb, rawClient: RawSqlClient, yamlText: string): Promise<{ inserted: number; skipped: number }> {
  const parsed: unknown = parse(yamlText);
  if (!isSourcesFile(parsed)) {
    throw new Error("sources.yml did not parse to { sources: [...] }");
  }

  // Validated up front, before a single row is written — a bad `kind` on the
  // fifth entry must not leave the first four seeded and the table half-built.
  for (const entry of parsed.sources) {
    if (!VALID_KINDS.has(entry.kind)) {
      throw new Error(`sources.yml: source "${entry.id}" has invalid kind "${entry.kind}"`);
    }
  }

  // Plain select() with no projection: AppDb is a union of three drizzle
  // dialects, and a projected select() doesn't resolve across all three
  // (db/client.ts's "only chain shapes common to all three" rule).
  const existingIds = new Set((await db.select().from(sources).all()).map((row) => row.id));
  const missing = parsed.sources.filter((entry) => !existingIds.has(entry.id));

  if (missing.length > 0) {
    await execAtomic(
      rawClient,
      missing.map((entry) => ({
        sql: "INSERT OR IGNORE INTO sources (id, kind, url, enabled) VALUES (?, ?, ?, ?)",
        params: [entry.id, entry.kind, entry.url, entry.enabled === false ? 0 : 1],
      })),
    );
  }

  return { inserted: missing.length, skipped: parsed.sources.length - missing.length };
}
