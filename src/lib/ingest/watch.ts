import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { fetchWithRetry } from "../drivers/http.ts";
import type { DriverError } from "../drivers/types.ts";
import { simhash64, simhashToHex } from "./simhash.ts";
import { parseFeed } from "./feed-parser.ts";
import { signals, sources } from "../../../db/schema.ts";
import type { createTestDb } from "../../../db/client.ts";

type Db = ReturnType<typeof createTestDb>["db"];

export interface WatchOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
}

export interface WatchSourceResult {
  sourceId: string;
  status: "unchanged" | "fetched" | "failed";
  itemsObserved: number;
  error?: DriverError;
}

/** sha256 of the canonical URL — the natural key that makes a retried WATCH idempotent (ARCHITECTURE.md §4). */
function canonicalUrlHash(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

/**
 * WATCH stage (ARCHITECTURE.md §5.1): polls one enabled source, with a
 * conditional GET against its stored ETag/Last-Modified, parses the feed,
 * and idempotently inserts new signals in the 'observed' state.
 */
export async function watchSource(
  db: Db,
  source: typeof sources.$inferSelect,
  options: WatchOptions = {},
): Promise<WatchSourceResult> {
  const userAgent = options.userAgent ?? "AutoShortsAI/0.1 (+https://github.com/isahalim/mythosengine)";
  const headers: Record<string, string> = { "user-agent": userAgent };
  if (source.etag) headers["if-none-match"] = source.etag;
  if (source.lastModified) headers["if-modified-since"] = source.lastModified;

  const fetchResult = await fetchWithRetry(
    source.url,
    { headers },
    { timeoutMs: options.timeoutMs ?? 15_000, maxAttempts: 3, baseDelayMs: 500, fetchImpl: options.fetchImpl },
  );

  if (!fetchResult.ok) {
    return { sourceId: source.id, status: "failed", itemsObserved: 0, error: fetchResult.error };
  }

  const res = fetchResult.value;
  if (res.status === 304) {
    return { sourceId: source.id, status: "unchanged", itemsObserved: 0 };
  }

  const body = await res.text();
  const parseResult = parseFeed(body);
  if (!parseResult.ok) {
    return { sourceId: source.id, status: "failed", itemsObserved: 0, error: parseResult.error };
  }

  const nowIso = new Date().toISOString();
  let inserted = 0;
  for (const item of parseResult.value) {
    const id = canonicalUrlHash(item.url);
    const insertResult = db
      .insert(signals)
      .values({
        id,
        sourceId: source.id,
        canonicalUrl: item.url,
        title: item.title,
        observedAt: nowIso,
        engagementScore: 1 / item.rank,
        simhash: simhashToHex(simhash64(item.title)),
        state: "observed",
      })
      .onConflictDoNothing()
      .run();
    if (insertResult.changes > 0) inserted++;
  }

  await db
    .update(sources)
    .set({
      lastSeenAt: nowIso,
      etag: res.headers.get("etag") ?? source.etag,
      lastModified: res.headers.get("last-modified") ?? source.lastModified,
    })
    .where(eq(sources.id, source.id))
    .run();

  return { sourceId: source.id, status: "fetched", itemsObserved: inserted };
}

export async function watchAllEnabledSources(db: Db, options: WatchOptions = {}): Promise<WatchSourceResult[]> {
  const enabled = db.select().from(sources).where(eq(sources.enabled, 1)).all();
  const results: WatchSourceResult[] = [];
  // Serialized, not Promise.all: this is polling external sites on a
  // schedule, not a burst — no reason to hit several at once and every
  // reason not to (rate limits, being a considerate crawler).
  for (const source of enabled) {
    results.push(await watchSource(db, source, options));
  }
  return results;
}
