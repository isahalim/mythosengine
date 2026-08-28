import { parse } from "yaml";
import { sources } from "../../../db/schema.ts";
import type { createTestDb } from "../../../db/client.ts";

type Db = ReturnType<typeof createTestDb>["db"];

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

/** Idempotently seeds `sources` from data/sources.yml — safe to re-run; existing rows are left untouched. */
export function seedSourcesFromYaml(db: Db, yamlText: string): { inserted: number; skipped: number } {
  const parsed: unknown = parse(yamlText);
  if (!isSourcesFile(parsed)) {
    throw new Error("sources.yml did not parse to { sources: [...] }");
  }

  let inserted = 0;
  let skipped = 0;
  for (const entry of parsed.sources) {
    if (!VALID_KINDS.has(entry.kind)) {
      throw new Error(`sources.yml: source "${entry.id}" has invalid kind "${entry.kind}"`);
    }
    const result = db
      .insert(sources)
      .values({
        id: entry.id,
        kind: entry.kind as "reddit" | "rss" | "x" | "youtube_community",
        url: entry.url,
        enabled: entry.enabled === false ? 0 : 1,
      })
      .onConflictDoNothing()
      .run();
    if (result.changes > 0) inserted++;
    else skipped++;
  }

  return { inserted, skipped };
}
