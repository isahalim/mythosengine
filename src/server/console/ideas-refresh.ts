import { eq } from "drizzle-orm";
import type { AppDb } from "../../../db/client.ts";
import { sources } from "../../../db/schema.ts";
import { watchSources } from "../../lib/ingest/watch.ts";
import { scoreObservedSignals } from "../../lib/ingest/score.ts";

/**
 * Stage 3 -> stage 4: pull the newest discourse before the operator picks
 * from it.
 *
 * **The ranking is BM25 and nothing else** (operator direction, 2026-09-03).
 * A model reranker sat here from 2026-09-02 and was deleted: reordering the
 * same corpus by the same prompt lands in nearly the same order every visit,
 * so it cost a request per stage entry and changed almost nothing about what
 * the operator saw. What makes stage 4 current is *ingest plus recency* —
 * getting today's stories into the corpus, and ranking them like they are
 * today's. Both of those are plain code. With the reranker gone the Worker
 * again makes no model call anywhere, which is where it was before
 * 2026-09-02 and where ARCHITECTURE.md §5.2.5 wants retrieval to sit.
 *
 * **Nothing here may fail the screen.** A dead feed, a rate-limited host, an
 * ingest that returns nothing: each leaves the operator looking at the ideas
 * they would have seen anyway, with a line saying why. This is an upgrade to
 * the list, never a precondition for it — the same rule the TTS and RESEARCH
 * upgrades follow.
 */

/**
 * Per-source fetch ceiling for the interactive path, against WATCH's own
 * 15,000.
 *
 * The scheduled job can afford to be patient; a person watching a stage
 * transition cannot. One source per host goes out concurrently, so this is
 * very nearly the whole wait the operator feels.
 */
const REFRESH_TIMEOUT_MS = 8_000;

export interface IngestResult {
  sourcesFetched: number;
  sourcesFailed: number;
  newSignals: number;
  /** Why the corpus is less fresh than it should be, or null when the refresh was clean. */
  degradedReason: string | null;
}

/**
 * The host a source is polled from — the unit a rate limit is actually
 * applied to.
 *
 * An unparseable URL falls back to the source id, which puts it in a group
 * of its own. That is the safe direction: a source that cannot be grouped is
 * polled on its own budget rather than silently sharing someone else's.
 */
function hostOf(source: typeof sources.$inferSelect): string {
  try {
    return new URL(source.url).host;
  } catch {
    return source.id;
  }
}

/**
 * One source per host, least-recently-polled first.
 *
 * **This is the whole fix for a stale Ideas list, and it is a measured one.**
 * `data/sources.yml` points at three reddit.com feeds, and the refresh used
 * to fetch every enabled source concurrently with three retries each — up to
 * nine reddit.com requests in one burst. Reddit answers that with 429 across
 * the board. Measured 2026-09-03 from one IP: three concurrent requests gave
 * 429/429/429; a single request gave 200 with 25 entries; a second request
 * five seconds later gave 429; the same request after ~45 seconds idle gave
 * 200 again. The budget is roughly one request per host per 30-60 seconds,
 * so a screen entry gets to spend exactly one on Reddit.
 *
 * Rotating by `lastSeenAt` is what makes one request per entry enough:
 * whichever subreddit is most out of date is the one that gets refreshed, so
 * three stage entries cover all three, and the one polled is always the one
 * with the most to say. Sorting is a total order — `lastSeenAt` first, then
 * `id` — so a never-polled source (null) always wins and two sources polled
 * in the same millisecond do not swap places between calls.
 *
 * Hosts that are not rate limited are unaffected: BBC and NPR are their own
 * groups and are polled on every entry.
 */
export function pickOnePerHost(enabled: readonly (typeof sources.$inferSelect)[]): (typeof sources.$inferSelect)[] {
  const byHost = new Map<string, typeof sources.$inferSelect>();
  for (const source of [...enabled].sort((a, b) => (a.lastSeenAt ?? "").localeCompare(b.lastSeenAt ?? "") || a.id.localeCompare(b.id))) {
    const host = hostOf(source);
    if (!byHost.has(host)) byHost.set(host, source);
  }
  return [...byHost.values()];
}

/**
 * Re-run WATCH's ingest and SCORE, once, for the stage transition.
 *
 * Reports what it managed rather than throwing, so the caller can tell the
 * operator "2 of 3 sources answered" instead of either lying by omission or
 * failing a screen over a feed outage.
 */
export async function ingestLatest(db: AppDb, log: (message: string) => void = console.warn): Promise<IngestResult> {
  const problems: string[] = [];
  let sourcesFetched = 0;
  let sourcesFailed = 0;
  let newSignals = 0;

  try {
    const enabled = await db.select().from(sources).where(eq(sources.enabled, 1)).all();
    const toPoll = pickOnePerHost(enabled);
    const results = await watchSources(db, toPoll, {
      timeoutMs: REFRESH_TIMEOUT_MS,
      // Safe only because `pickOnePerHost` guarantees no two of these share
      // a rate limit bucket.
      concurrent: true,
      // A 429 here is a per-minute window this request cannot wait out
      // inside an 8-second budget; retrying spends the next entry's request
      // to learn the same thing. See WatchOptions.retryOn429.
      retryOn429: false,
    });
    for (const result of results) {
      if (result.status === "failed") sourcesFailed++;
      else sourcesFetched++;
      newSignals += result.itemsObserved;
    }
    if (sourcesFailed > 0) problems.push(`${sourcesFailed} of ${results.length} source(s) did not answer`);
  } catch (cause) {
    // Never rethrown: the operator gets the corpus as it stands.
    const message = cause instanceof Error ? cause.message : String(cause);
    log(`IDEAS REFRESH: ingest failed (${message}) — serving the corpus as it stands.`);
    problems.push(`ingest failed: ${message}`);
  }

  // Newly ingested signals arrive `observed`, and `rankIdeas` only offers
  // `scored` ones. Without this the fetch above would be invisible.
  if (newSignals > 0) {
    try {
      await scoreObservedSignals(db);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      log(`IDEAS REFRESH: scoring failed (${message}) — the ${newSignals} new signal(s) stay unscored for now.`);
      problems.push(`scoring failed: ${message}`);
    }
  }

  return { sourcesFetched, sourcesFailed, newSignals, degradedReason: problems.length === 0 ? null : problems.join("; ") };
}
