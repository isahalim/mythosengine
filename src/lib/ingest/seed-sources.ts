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
 * Idempotently reconciles `sources` with data/sources.yml — safe to re-run.
 * New ids are inserted; existing ids have their `url` and `enabled` brought
 * back in line with the file.
 *
 * **Existing rows used to be left untouched, and that was a silent trap.**
 * The header below says the table's contents should be a consequence of the
 * committed YAML, but only insertion honoured that: editing a `url` in the
 * file changed nothing in a database that had already been seeded, so the
 * pipeline kept polling the old feed while the repository said otherwise and
 * nothing anywhere reported a difference. Found on 2026-09-03 moving the
 * Reddit sources from `hot.rss` to `rising.rss`, which would have been a
 * no-op in production.
 *
 * A changed URL also drops that row's `etag` and `last_modified`. They are
 * validators for the *old* resource, and handing a stored `If-Modified-Since`
 * to a different feed can earn a 304 for a document this system has never
 * actually read — a source that looks polled and is permanently empty.
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
export async function seedSourcesFromYaml(db: AppDb, rawClient: RawSqlClient, yamlText: string): Promise<{ inserted: number; updated: number; skipped: number }> {
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
  const existing = new Map((await db.select().from(sources).all()).map((row) => [row.id, row]));
  const missing = parsed.sources.filter((entry) => !existing.has(entry.id));

  const changed = parsed.sources.filter((entry) => {
    const row = existing.get(entry.id);
    if (row === undefined) return false;
    return row.url !== entry.url || row.enabled !== (entry.enabled === false ? 0 : 1);
  });

  // One batch for both, so a run that inserts a new source and re-points an
  // existing one either applies wholly or not at all — CLAUDE.md's "never a
  // multi-step database mutation outside a transaction" covers seeding too.
  const statements = [
    ...missing.map((entry) => ({
      sql: "INSERT OR IGNORE INTO sources (id, kind, url, enabled) VALUES (?, ?, ?, ?)",
      params: [entry.id, entry.kind, entry.url, entry.enabled === false ? 0 : 1] as (string | number)[],
    })),
    ...changed.map((entry) => ({
      // The conditional validator reset: cleared only when the URL is
      // genuinely different, so merely toggling `enabled` does not throw away
      // a working conditional GET and re-download a feed for nothing.
      sql:
        existing.get(entry.id)?.url === entry.url
          ? "UPDATE sources SET enabled = ? WHERE id = ?"
          : "UPDATE sources SET url = ?, enabled = ?, etag = NULL, last_modified = NULL WHERE id = ?",
      params:
        existing.get(entry.id)?.url === entry.url
          ? ([entry.enabled === false ? 0 : 1, entry.id] as (string | number)[])
          : ([entry.url, entry.enabled === false ? 0 : 1, entry.id] as (string | number)[]),
    })),
  ];

  if (statements.length > 0) await execAtomic(rawClient, statements);

  return { inserted: missing.length, updated: changed.length, skipped: parsed.sources.length - missing.length - changed.length };
}
