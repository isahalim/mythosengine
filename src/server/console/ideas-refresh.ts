import type { AppDb } from "../../../db/client.ts";
import type { LlmDriver } from "../../lib/drivers/types.ts";
import { watchAllEnabledSources } from "../../lib/ingest/watch.ts";
import { scoreObservedSignals } from "../../lib/ingest/score.ts";
import { rerankByLabel } from "../../lib/rag/rerank.ts";
import { GROQ_REASONING_MODEL } from "../../config/models.ts";
import { rankIdeas, TOPIC_QUERIES, type RankedIdea, type Topic } from "./ideas.ts";

/**
 * Stage 3 -> stage 4: pull the newest discourse, then let the model order it
 * (operator direction, 2026-09-02).
 *
 * **What changed, and that it is a real change.** `ideas.ts` was
 * deliberately retrieval-only — BM25 over whatever WATCH had already
 * ingested, no model call — and the Worker as a whole made no model call at
 * all after the console was deleted on 2026-08-31. Both are now false for
 * this one path, because the operator asked for stage 4 to show the latest
 * information and a genuinely different set on each entry.
 *
 * Reranking alone would not have delivered that. The same corpus reordered
 * by the same prompt lands in nearly the same order every visit, so the
 * ingest half is what makes the list *new* and the rerank half is what makes
 * it *good*. Building only the second would have looked like the feature and
 * behaved like a cache.
 *
 * **The two halves are separate functions because they have different
 * cardinalities.** Stage 4 asks for one topic per video, and a video set to
 * "let the agent decide" asks for all seven at once. Ingest must happen
 * exactly once per entry regardless — seven concurrent crawls of the same
 * five feeds is a race, not a refresh — while ranking is inherently
 * per-topic. Folding both into one endpoint made the agent path do seven of
 * everything.
 *
 * **Nothing here may fail the screen.** A dead feed, a rate-limited model,
 * an ingest that returns nothing: each leaves the operator looking at the
 * ideas they would have seen anyway. This is an upgrade to the list, never a
 * precondition for it — the same rule the TTS and RESEARCH upgrades follow.
 */

/**
 * Per-source fetch ceiling for the interactive path, against WATCH's own
 * 15,000.
 *
 * The scheduled job can afford to be patient; a person watching a stage
 * transition cannot. The sources are fetched concurrently, so this is very
 * nearly the whole wait the operator feels.
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
 * Re-run WATCH's ingest and SCORE, once, for the stage transition.
 *
 * Reports what it managed rather than throwing, so the caller can tell the
 * operator "3 of 5 sources answered" instead of either lying by omission or
 * failing a screen over a feed outage.
 */
export async function ingestLatest(db: AppDb, log: (message: string) => void = console.warn): Promise<IngestResult> {
  const problems: string[] = [];
  let sourcesFetched = 0;
  let sourcesFailed = 0;
  let newSignals = 0;

  // Concurrent, unlike the scheduled WATCH, which is serial on purpose ("no
  // reason to hit several at once and every reason not to"). That reasoning
  // is about being a considerate crawler on a timer over an open-ended
  // source list. This is a handful of conditional GETs a person triggered
  // and is waiting on, most of which come back 304.
  try {
    const results = await watchAllEnabledSources(db, { timeoutMs: REFRESH_TIMEOUT_MS, concurrent: true });
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

/**
 * How many candidates the model sees for every one the operator does.
 *
 * The same 3x `rerank.ts` gives its retriever, for the same reason:
 * reordering exactly the items BM25 already chose can only permute a
 * decision already made. A reranker earns its request by what it promotes
 * from further down the list.
 */
const RERANK_MULTIPLIER = 3;

export interface RerankedIdeas {
  ideas: RankedIdea[];
  /** The model that produced this order, or null when the order is BM25's. */
  rerankedBy: string | null;
  /** Why the model did not order it, or null when it did. */
  degradedReason: string | null;
}

/**
 * One topic's ideas, ordered by the model.
 *
 * **The returned order is the answer.** A caller that re-sorts this by
 * `score` throws the rerank away silently — `score` is BM25's blend, and the
 * reranker deliberately does not write to it, because a model ordering seven
 * headlines has not produced a number that means anything beside an
 * engagement metric. `rerankedBy` is how a caller tells an ordered list from
 * an unordered one without guessing.
 */
export async function rankIdeasReranked(
  db: AppDb,
  topic: Topic,
  limit: number,
  exclude: string[],
  llm: LlmDriver,
  log: (message: string) => void = console.warn,
): Promise<RerankedIdeas> {
  const candidates = await rankIdeas(db, topic, Math.max(limit * RERANK_MULTIPLIER, limit), exclude);

  // Source kind and title only. The operator picks a story by reading its
  // headline, so that is what the model should judge too — and it keeps the
  // request small enough that a screen refresh is a rounding error against
  // the day's token budget.
  const { ranked, reason } = await rerankByLabel(llm, TOPIC_QUERIES[topic], candidates, (idea) => `${idea.sourceKind} | ${idea.title}`, limit, log);

  return { ideas: ranked, rerankedBy: reason === null ? GROQ_REASONING_MODEL : null, degradedReason: reason };
}
