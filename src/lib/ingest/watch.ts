import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { fetchWithRetry } from "../drivers/http.ts";
import type { DriverError } from "../drivers/types.ts";
import { simhash64, simhashToHex } from "./simhash.ts";
import { parseFeed } from "./feed-parser.ts";
import { signals, sources } from "../../../db/schema.ts";
import type { AppDb } from "../../../db/client.ts";

type Db = AppDb;

export interface WatchOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
  /**
   * Fetch every source at once instead of one after another.
   *
   * Off by default, because the scheduled job's serial poll is a deliberate
   * choice and not an oversight — see `watchAllEnabledSources`. On for the
   * Ideas screen's refresh (src/server/console/ideas-refresh.ts), which is a
   * person waiting on a result rather than a crawler on a timer — but only
   * safe there because that caller now sends **one source per host**. Firing
   * three reddit.com feeds at once is what this flag used to do, and Reddit
   * answered all three with 429.
   */
  concurrent?: boolean;
  /**
   * Whether a 429 is worth a second attempt. Default true, matching
   * `fetchWithRetry`.
   *
   * False for the interactive refresh, and measured rather than assumed:
   * Reddit's RSS budget from one IP is roughly a request per 30-60 seconds
   * (a second request 5s after a 200 came back 429; the same request after
   * ~45s idle came back 200). Three attempts inside an 8-second timeout
   * cannot outrun a window that long — they only spend the next window's
   * request too. This is the same lesson `http.ts` already carries for a
   * daily quota and CLAUDE.md carries for Gemini TTS: retrying a rate limit
   * you cannot wait out buys a second copy of the same answer.
   */
  retryOn429?: boolean;
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
  const userAgent = options.userAgent ?? "MythosEngine/0.1 (+https://github.com/isahalim/mythosengine)";
  const headers: Record<string, string> = { "user-agent": userAgent };
  if (source.etag) headers["if-none-match"] = source.etag;
  if (source.lastModified) headers["if-modified-since"] = source.lastModified;

  const fetchResult = await fetchWithRetry(
    source.url,
    { headers },
    {
      timeoutMs: options.timeoutMs ?? 15_000,
      // One attempt when 429s are not worth retrying: the retry budget is
      // the thing being conserved, so spending three attempts to learn the
      // same thing is the failure, not the fix.
      maxAttempts: options.retryOn429 === false ? 1 : 3,
      baseDelayMs: 500,
      fetchImpl: options.fetchImpl,
      ...(options.retryOn429 === false ? { retryOn429: false } : {}),
    },
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
    // .returning().all() instead of .run()'s `.changes` — `.run()`'s result
    // shape is dialect-specific (better-sqlite3's RunResult vs. D1's
    // D1Result, which nests changes under `.meta` vs. sqlite-proxy's
    // `{rows}` — none of which is a chain shape common to all three
    // dialects, per db/client.ts's own AppDb discipline). `.returning()`
    // is: every dialect returns the inserted row only when a row was
    // actually inserted (empty array on the onConflictDoNothing no-op).
    // Bare `.returning()` (not `.returning({id: ...})`) — TypeScript
    // collapses drizzle's field-mapping overload to 0 arguments when the
    // receiver is typed as AppDb (a union of three dialects' distinct
    // builder classes); the full row works just as well here since only
    // `.length` is checked.
    const insertResult = await db
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
      .returning()
      .all();
    if (insertResult.length > 0) inserted++;
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

/**
 * Polls an explicit list of sources.
 *
 * Split out from `watchAllEnabledSources` on 2026-09-03 so the Ideas
 * refresh can poll a *subset* — one source per host — rather than every
 * enabled row. The scheduled job still wants all of them, and calls the
 * wrapper below.
 */
export async function watchSources(db: Db, toPoll: readonly (typeof sources.$inferSelect)[], options: WatchOptions = {}): Promise<WatchSourceResult[]> {
  // Serialized by default, not Promise.all: the scheduled poll hits external
  // sites on a timer, and there is no reason to hit several at once and
  // every reason not to (rate limits, being a considerate crawler).
  //
  // `concurrent` is the exception the Ideas refresh asks for, and it is a
  // different situation rather than the same one in a hurry: a person
  // triggered it and is waiting on it. It is only sound because that caller
  // sends one source per host, so no two requests in the batch share a rate
  // limit bucket.
  if (options.concurrent) {
    return Promise.all(toPoll.map((source) => watchSource(db, source, options)));
  }

  const results: WatchSourceResult[] = [];
  for (const source of toPoll) {
    results.push(await watchSource(db, source, options));
  }
  return results;
}

export async function watchAllEnabledSources(db: Db, options: WatchOptions = {}): Promise<WatchSourceResult[]> {
  return watchSources(db, await db.select().from(sources).where(eq(sources.enabled, 1)).all(), options);
}
