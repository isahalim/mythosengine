import { ArticleFetchDriver } from "../drivers/article-fetch.ts";
import { createGeminiResearchDriverFromEnv } from "../drivers/resolve-gemini-driver.ts";
import { createGroqReasoningLadder } from "../drivers/resolve-ladder.ts";
import type { DriverError, LlmDriver } from "../drivers/types.ts";
import type { Result } from "../result.ts";
import { GEMINI_RESEARCH_MAX_ITERATIONS, GEMINI_RESEARCH_MODEL, GROQ_REASONING_MODEL } from "../../config/models.ts";
import { researchSignal, type ResearchBrief, type ResearchOptions } from "./research.ts";
import type { Retriever } from "./retriever.ts";

/**
 * Which provider answers RESEARCH, and what happens when the first one does
 * not (operator direction, 2026-09-02).
 *
 * **Gemini 3.7 Flash gets one bounded attempt; Groq answers everything
 * else.** The trade is specifically about intake, not about which model is
 * cleverer. On Groq the whole tool conversation has to fit inside a
 * 7,200-token per-request ceiling, and `fitToRequestBudget` gets there by
 * discarding tool results the model already fetched — a real, measured loss
 * of grounding, recorded as `toolResultsDropped` and visible in the audit
 * package. Gemini's intake is large enough that nothing needs discarding.
 *
 * **Why this is not the 2026-09-01 arrangement returning.** That one put
 * five stages on Gemini and lost a render; this one puts a quarter of one
 * stage there. Three specific things are different:
 *
 * 1. *Four turns, not six.* The free tier meters 5 requests/minute per
 *    model. RESEARCH's full loop is six, so the old arrangement crossed the
 *    ceiling inside a single stage — it peaked at 6/5 and died. Four cannot
 *    reach it. The limiter in `createGeminiResearchDriverFromEnv` exists for
 *    the case the cap cannot see (two renders inside one minute), not for
 *    this one.
 * 2. *Fall back on **any** failure.* The deleted `withGroqFallback` fell
 *    back only on quota exhaustion, so the two `500 InternalServerError`s
 *    the 2026-09-01 run drew fell through it and took SCRIPT down. A 500, a
 *    429, a timeout, malformed JSON, a brief that fails schema validation
 *    and a loop that never stops calling tools are all the same event here:
 *    stop asking Gemini, ask Groq.
 * 3. *No second Gemini attempt.* Descending to another Gemini model for the
 *    remaining turns would buy a separate per-model bucket, and it was
 *    considered and declined on 2026-09-02: Gemini tool transcripts carry
 *    signed `thought` steps, and whether a second model accepts the first's
 *    signatures is untested. The fallback is Groq, which is known to work.
 *
 * **The Groq side is a two-rung ladder since 2026-09-04** —
 * `gpt-oss-120b` and then `gpt-oss-20b`, on separate daily token
 * allowances (`createGroqReasoningLadder`). That is the operator's
 * "then fall back to gpt-oss-20b" applied here as it is everywhere else the
 * 120b model is used. What it deliberately does *not* pick up is the
 * `GEMINI_REASONING_MODEL` rung the other stages get on top: this stage has
 * already had its Gemini attempt, on the model and the intake budget chosen
 * for it, and giving RESEARCH a second one would be the 2026-09-02 decision
 * reversed by accident rather than by direction.
 *
 * Absent `GEMINI_API_KEY` this is simply the Groq ladder, unchanged and
 * unslowed — the same rule that governs the Gemini TTS upgrade. An upgrade
 * must not become a dependency.
 */

/**
 * The per-request ceiling for the Gemini attempt, in estimated tokens.
 *
 * Groq's number is a hard provider limit (a request over 8,000 is refused
 * with a 413 before it runs). This one is not: it is a self-imposed cap on
 * how much of the day's 250K-token allowance one render may spend, sized so
 * that four turns each re-sending a conversation with three full articles in
 * it never come close to it. If it ever does bind, the same
 * `fitToRequestBudget` trimming applies and the same `toolResultsDropped`
 * count reaches the audit package, so a run that hits it says so.
 */
export const GEMINI_RESEARCH_REQUEST_CEILING = 60_000;

/**
 * Characters of source text `read_source` returns on the Gemini attempt,
 * against the 6,000 the Groq path can afford.
 *
 * This is the single largest quality difference between the two paths. Six
 * thousand characters is roughly the first third of a news article, and a
 * brief written from three truncated articles is reasoning about openings.
 */
export const GEMINI_RESEARCH_SOURCE_CHARS = 24_000;

/**
 * Candidates one `search_discourse` call returns on the Gemini attempt,
 * against 8 on Groq.
 *
 * Twice the breadth, and it costs the Gemini attempt nothing, because the
 * reason the Groq number is small is that every result is re-sent on every
 * later turn against a ceiling this path does not have. It also partly
 * compensates for the shorter loop: with four turns rather than six there is
 * less room to re-search under a different phrasing, so each search should
 * see more.
 */
export const GEMINI_RESEARCH_SEARCH_RESULTS = 16;

/** One provider's configured attempt at the stage: a driver, a source reader, and the bounds appropriate to it. */
interface ResearchAttempt {
  llm: LlmDriver;
  articles: Pick<ArticleFetchDriver, "fetchArticle">;
  options: ResearchOptions;
}

export interface ResearchProviders {
  /** Null when `GEMINI_API_KEY` is unset — then Groq is not a fallback, it is simply the path. */
  gemini: ResearchAttempt | null;
  groq: ResearchAttempt;
  /** Why Gemini is not being tried, ready for the audit package. Null when it is. */
  unavailableReason: string | null;
}

export interface ResearchOutcome {
  result: Result<ResearchBrief, DriverError>;
  /** Which provider produced `result` — the one that actually answered, not the one that was preferred. */
  provider: "gemini" | "groq";
  /**
   * Why Gemini did not produce this brief, or null when it did.
   *
   * Never null-and-silent on a fallback. CLAUDE.md's NEVER block requires
   * the audit package to record which provider actually answered each
   * reasoning stage, and a reviewer comparing two exports needs to be able
   * to tell "Gemini was out of quota" from "Gemini wrote a brief with no
   * traceable citation" — neither of which is recoverable from the brief.
   */
  fallbackReason: string | null;
}

/**
 * Builds both attempts. `groqLlm` is the render's shared, rate-limited Groq
 * driver; the Gemini driver is constructed here because only this file knows
 * that RESEARCH is the one stage that wants one.
 */
export function selectResearchProviders(groqLlm: LlmDriver, geminiApiKey: string | undefined): ResearchProviders {
  const groq: ResearchAttempt = {
    // gpt-oss-120b, then gpt-oss-20b on any failure. The bounds below are
    // sized for Groq's 7,200-token per-request ceiling and apply to both
    // rungs, so a mid-loop step down cannot hand the next model a request
    // it will refuse with a 413.
    llm: createGroqReasoningLadder(groqLlm, "RESEARCH"),
    // Default 6,000 characters per source, default 8 results, default six
    // turns, default 7,200-token ceiling: this is today's path, untouched.
    articles: new ArticleFetchDriver(),
    // The rung asked for first. `researchSignal` records the model that
    // actually answered (`modelUsed`), not this one.
    options: { model: GROQ_REASONING_MODEL },
  };

  if (!geminiApiKey) {
    return { gemini: null, groq, unavailableReason: "GEMINI_API_KEY is not set — RESEARCH ran on Groq, as it does when the upgrade is absent" };
  }

  return {
    gemini: {
      llm: createGeminiResearchDriverFromEnv(geminiApiKey),
      articles: new ArticleFetchDriver({ maxChars: GEMINI_RESEARCH_SOURCE_CHARS }),
      options: {
        model: GEMINI_RESEARCH_MODEL,
        maxIterations: GEMINI_RESEARCH_MAX_ITERATIONS,
        requestTokenCeiling: GEMINI_RESEARCH_REQUEST_CEILING,
        maxSearchResults: GEMINI_RESEARCH_SEARCH_RESULTS,
      },
    },
    groq,
    unavailableReason: null,
  };
}

/**
 * Runs RESEARCH on the best available provider and reports which one
 * answered.
 *
 * The Groq result is returned as-is, success or failure. RESEARCH is allowed
 * to fail — RENDER exports the video flagged `ungrounded` rather than losing
 * it (CLAUDE.md, ARCHITECTURE.md §5.2.5) — so there is deliberately nothing
 * below Groq to fall to.
 */
export async function researchWithFallback(
  providers: ResearchProviders,
  retriever: Retriever,
  signal: { id: string; title: string },
  log: (message: string) => void = console.warn,
): Promise<ResearchOutcome> {
  if (providers.gemini !== null) {
    const { llm, articles, options } = providers.gemini;
    const attempt = await researchSignal(llm, retriever, articles, signal, options);
    if (attempt.ok) {
      return { result: attempt, provider: "gemini", fallbackReason: null };
    }
    // Logged with its kind, never swallowed: this is the line that tells the
    // operator whether the upgrade is working at all, and the only place a
    // rate limit or a 500 is visible before the audit package is written.
    const reason = `${attempt.error.kind}: ${attempt.error.message}`;
    log(`RESEARCH on ${GEMINI_RESEARCH_MODEL} failed (${reason}) — falling back to ${GROQ_REASONING_MODEL}.`);
    const fallback = await researchWithGroq(providers, retriever, signal);
    return { ...fallback, fallbackReason: reason };
  }

  const fallback = await researchWithGroq(providers, retriever, signal);
  return { ...fallback, fallbackReason: providers.unavailableReason };
}

async function researchWithGroq(
  providers: ResearchProviders,
  retriever: Retriever,
  signal: { id: string; title: string },
): Promise<Omit<ResearchOutcome, "fallbackReason">> {
  const { llm, articles, options } = providers.groq;
  return { result: await researchSignal(llm, retriever, articles, signal, options), provider: "groq" };
}
