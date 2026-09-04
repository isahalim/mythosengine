import { ArticleFetchDriver } from "../drivers/article-fetch.ts";
import { createGeminiResearchDriverFromEnv } from "../drivers/resolve-gemini-driver.ts";
import type { LadderUse } from "../drivers/llm-ladder.ts";
import type { ReasoningLadders } from "../drivers/resolve-ladder.ts";
import type { DriverError, LlmDriver } from "../drivers/types.ts";
import type { Result } from "../result.ts";
import { GEMINI_RESEARCH_MAX_ITERATIONS, GEMINI_RESEARCH_MODEL, GROQ_REASONING_MODEL } from "../../config/models.ts";
import { researchSignal, type ResearchBrief, type ResearchOptions } from "./research.ts";
import type { Retriever } from "./retriever.ts";

/**
 * Which provider answers RESEARCH, and what happens when the first one does
 * not (operator direction, 2026-09-02).
 *
 * **`GEMINI_RESEARCH_MODEL` gets one bounded attempt; the general reasoning
 * ladder answers everything else.** The trade is specifically about intake,
 * not about which model is cleverer. On Groq the whole tool conversation has
 * to fit inside a 7,200-token per-request ceiling, and `fitToRequestBudget`
 * gets there by discarding tool results the model already fetched — a real,
 * measured loss of grounding, recorded as `toolResultsDropped` and visible
 * in the audit package. Gemini's intake is large enough that nothing needs
 * discarding.
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
 * 3. *No second Gemini model **inside this loop**.* Descending mid-loop
 *    would hand the next model this one's signed `thought` steps, and
 *    whether that is accepted is untested (2026-09-02). So this attempt is
 *    one model from its first turn to its last, and it is abandoned whole.
 *
 * **The fallback is the general reasoning ladder since 2026-09-04** —
 * `GEMINI_REASONING_MODEL`, then `gpt-oss-120b`, then `gpt-oss-20b` — which
 * is the operator's "then fall back to the gemini 3.5 flash-lite and the
 * groq api's gpt models", in the operator's order. It used to be a Groq-only
 * variant of the same ladder, on the reading that a stage which had spent a
 * Gemini attempt must not get another. What changed is not the rule, it is
 * where the rule bites: point 3 above is about a *transcript*, and this is a
 * different transcript. `researchWithFallback` throws the first attempt away
 * — every message, every `thought` step — and `researchSignal` starts again
 * from the system prompt, on a different model id and so a different
 * per-minute bucket. Nothing crosses.
 *
 * The ladder instance is the render's own (`ReasoningLadders.forStage`), not
 * one built here, so this stage's Gemini rung is the *same driver and the
 * same limiter* SCRIPT, PLAN and reranking hold. Three private limiters
 * against one 5-requests-per-minute meter is the arithmetic that lost the
 * 2026-09-01 render, and it is the one thing about sharing this ladder that
 * is not optional.
 *
 * The bounds below stay Groq's — six turns, 6,000 characters a source, the
 * 7,200-token request ceiling derived from Groq's real 413. They belong to
 * the stage rather than to the rung, so a mid-loop descent can never hand
 * Groq a request it will refuse, and the Gemini rung simply runs inside a
 * budget smaller than it needs. That is the right way round: the rung that
 * has to survive is the one at the bottom.
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
  /** Null when `GEMINI_API_KEY` is unset — then the fallback is not a fallback, it is simply the path. */
  gemini: ResearchAttempt | null;
  /**
   * The fallback attempt: the render's general reasoning ladder, which since
   * 2026-09-04 has a Gemini rung of its own on top of the two Groq ones.
   *
   * Still named `groq` because that is what it is nine times in ten and
   * renaming it would churn every call site and test for a field whose
   * meaning has not moved: this is *the attempt below the first one*.
   * `fallbackUsed` is what says which rung of it actually spoke.
   */
  groq: ResearchAttempt;
  /**
   * Which rung of the fallback ladder answered, or null before it has run
   * (and whenever a plain driver was supplied instead of a ladder).
   *
   * This exists because the fallback stopped being all-Groq on 2026-09-04.
   * Reporting `provider: "groq"` beside `model: "gemini-3.5-flash-lite"`
   * would be an audit package that contradicts itself, and CLAUDE.md's NEVER
   * block is specifically about a reviewer being able to tell which provider
   * answered a stage.
   */
  fallbackUsed: () => LadderUse | null;
  /** Why the first attempt is not being tried, ready for the audit package. Null when it is. */
  unavailableReason: string | null;
}

export interface ResearchOutcome {
  result: Result<ResearchBrief, DriverError>;
  /** Which provider produced `result` — the one that actually answered, not the one that was preferred. */
  provider: "gemini" | "groq";
  /**
   * The model id that actually answered, or null when none did.
   *
   * Read off the attempt itself — the brief's own `modelUsed` on the first
   * attempt, the ladder's `lastUsed()` on the fallback — never assumed from
   * `provider`. Since the fallback became a ladder with rungs on two
   * providers, "which provider" no longer implies "which model", and the
   * audit package needs both.
   */
  model: string | null;
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
 * Builds both attempts. `ladders` is the render's shared set of reasoning
 * ladders, which RESEARCH takes a stage instance of like every other stage;
 * the *first* attempt's Gemini driver is constructed here, because only this
 * file knows that RESEARCH is the one stage that wants a large-intake model
 * of its own.
 */
export function selectResearchProviders(ladders: ReasoningLadders, geminiApiKey: string | undefined): ResearchProviders {
  // One instance, held so `fallbackUsed` can be asked afterwards which rung
  // spoke. A ladder per stage is the rule (the descent is sticky and must
  // not be shared), over drivers that are shared — `ladders` is what owns
  // that distinction.
  const fallbackLadder = ladders.forStage("RESEARCH");
  const groq: ResearchAttempt = {
    // The render's own general ladder — Flash Lite, then gpt-oss-120b, then
    // gpt-oss-20b, each rung tried only when the one above it errored. The
    // bounds below are sized for Groq's 7,200-token per-request ceiling and
    // apply to every rung, so a mid-loop step down cannot hand the next
    // model a request it will refuse with a 413.
    llm: fallbackLadder,
    // Default 6,000 characters per source, default 8 results, default six
    // turns, default 7,200-token ceiling: this is today's path, untouched.
    articles: new ArticleFetchDriver(),
    // The rung asked for first is decided by the ladder, which ignores this
    // entirely; it is the default for the case a plain driver is handed in.
    // `researchSignal` records the model that actually answered
    // (`modelUsed`), never this one.
    options: { model: GROQ_REASONING_MODEL },
  };

  const fallbackUsed = (): LadderUse | null => fallbackLadder.lastUsed();

  if (!geminiApiKey) {
    return { gemini: null, groq, fallbackUsed, unavailableReason: "GEMINI_API_KEY is not set — RESEARCH ran on Groq, as it does when the upgrade is absent" };
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
    fallbackUsed,
    unavailableReason: null,
  };
}

/**
 * Runs RESEARCH on the best available provider and reports which one
 * answered.
 *
 * The fallback's result is returned as-is, success or failure. RESEARCH is
 * allowed to fail — RENDER exports the video flagged `ungrounded` rather
 * than losing it (CLAUDE.md, ARCHITECTURE.md §5.2.5) — so there is
 * deliberately nothing below the ladder's last rung to fall to.
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
      return { result: attempt, provider: "gemini", model: attempt.value.model, fallbackReason: null };
    }
    // Logged with its kind, never swallowed: this is the line that tells the
    // operator whether the upgrade is working at all, and the only place a
    // rate limit or a 500 is visible before the audit package is written.
    const reason = `${attempt.error.kind}: ${attempt.error.message}`;
    log(`RESEARCH on ${GEMINI_RESEARCH_MODEL} failed (${reason}) — starting again on the general ladder.`);
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
  const result = await researchSignal(llm, retriever, articles, signal, options);
  // Which rung spoke, read back rather than assumed. The fallback ladder's
  // top rung is a Gemini model since 2026-09-04, so "the fallback ran" and
  // "Groq answered" stopped being the same sentence. A ladder that never got
  // a completion out of any rung reports null, and `provider` falls back to
  // the ladder's own floor, which is where it would have ended up.
  const used = providers.fallbackUsed();
  return { result, provider: used?.provider ?? "groq", model: used?.model ?? null };
}
