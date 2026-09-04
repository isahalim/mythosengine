import { LadderLlmDriver, type LadderRung } from "./llm-ladder.ts";
import { createGeminiReasoningDriverFromEnv } from "./resolve-gemini-driver.ts";
import type { LlmDriver } from "./types.ts";
import { EDIT_FALLBACK_MODEL, EDIT_MODEL, GEMINI_REASONING_MODEL, GROQ_LIGHT_MODEL, GROQ_REASONING_MODEL } from "../../config/models.ts";

/**
 * Where a stage's ladder is built. The rungs are named in
 * `src/config/models.ts` and assembled here, so no stage ever spells a model
 * id — the drift CLAUDE.md's NEVER block is about, and the one CRITIC
 * demonstrated by naming `"openai/gpt-oss-120b"` inline and missing every
 * model change until 2026-09-03.
 */

/**
 * Hands out one `LadderLlmDriver` per stage over **one shared set of
 * drivers**.
 *
 * Both halves of that matter and they pull in opposite directions:
 *
 * - *A ladder per stage*, because the descent is sticky. A rate-limited
 *   rerank should not decide that SCRIPT starts one rung down, and each
 *   stage has to be able to report which rung actually answered it
 *   (`lastUsed()`) for the audit package.
 * - *Shared drivers*, because the rate limits are per account and per model,
 *   not per stage. The Groq driver arrives already holding the render's one
 *   token bucket; the Gemini rung is constructed once here for exactly the
 *   same reason. Three stages holding three private Gemini limiters would
 *   each believe they had the whole 5 requests/minute.
 */
export interface ReasoningLadders {
  /** A fresh ladder for one stage. `stage` only labels the log line a descent emits. */
  forStage(stage: string): LadderLlmDriver;
  /** Why there is no Gemini rung, or null when there is one. Goes to the render log. */
  geminiUnavailableReason: string | null;
}

/**
 * The general reasoning ladder: **Gemini Flash Lite → gpt-oss-120b →
 * gpt-oss-20b**, for SCRIPT, PLAN, retrieval reranking and RESEARCH's
 * post-`GEMINI_RESEARCH_MODEL` fallback (operator direction, 2026-09-04).
 *
 * *RESEARCH's fallback takes the Gemini rung too, since 2026-09-04.* It used
 * to take a Groq-only variant of this ladder, so that a stage which had
 * already spent a Gemini attempt could not get a second one. The operator's
 * direction that day was explicit — 3.8 Flash first, "then fall back to the
 * gemini 3.5 flash-lite and the groq api's gpt models" — and the rule it
 * appears to cross is narrower than it reads. What 2026-09-02 ruled out is a
 * Gemini→Gemini descent *inside one tool conversation*, where the second
 * model inherits the first's signed `thought` steps. RESEARCH's fallback is
 * not that: `researchWithFallback` abandons the first attempt completely and
 * starts a new loop from an empty transcript, on a different model id and so
 * a different per-minute bucket. `LadderLlmDriver`'s own invariant — at most
 * one Gemini rung, at the top — is what still holds the line inside a single
 * loop, and it is unchanged.
 *
 * Absent `GEMINI_API_KEY` the ladder is simply the two Groq rungs, which is
 * a strict improvement on what those stages had yesterday — SCRIPT used to
 * fail the render outright when 120b was rate-limited, and now there is a
 * model beneath it on a separate daily allowance.
 *
 * `groqLlm` is the render's shared, rate-limited Groq driver; both Groq
 * rungs use it, so they queue behind one token bucket rather than racing
 * each other into a 429.
 */
export function createReasoningLadders(
  groqLlm: LlmDriver,
  geminiApiKey: string | undefined,
  onEvent: (event: string) => void = (event) => console.warn(event),
): ReasoningLadders {
  const groqRungs = groqReasoningRungs(groqLlm);

  if (geminiApiKey === undefined || geminiApiKey.length === 0) {
    return {
      forStage: (stage) => new LadderLlmDriver(groqRungs, (event) => onEvent(`${stage}: ${event}`)),
      geminiUnavailableReason: `GEMINI_API_KEY is not set — SCRIPT, PLAN and reranking ran on Groq, as they do when the upgrade is absent`,
    };
  }

  // One driver, one limiter, however many ladders ask for a rung.
  const geminiLlm = createGeminiReasoningDriverFromEnv(geminiApiKey);
  const rungs: LadderRung[] = [{ provider: "gemini", model: GEMINI_REASONING_MODEL, llm: geminiLlm }, ...groqRungs];

  return {
    forStage: (stage) => new LadderLlmDriver(rungs, (event) => onEvent(`${stage}: ${event}`)),
    geminiUnavailableReason: null,
  };
}

/** The two Groq rungs of the general ladder, in order. Shared so RESEARCH's fallback and the reasoning ladder cannot drift apart. */
function groqReasoningRungs(groqLlm: LlmDriver): LadderRung[] {
  return [
    { provider: "groq", model: GROQ_REASONING_MODEL, llm: groqLlm },
    { provider: "groq", model: GROQ_LIGHT_MODEL, llm: groqLlm },
  ];
}

/**
 * EDIT's ladder: **qwen3.8-27b → qwen3.6-27b**, both on Groq (operator
 * direction, 2026-09-04).
 *
 * No Gemini rung, and that is deliberate rather than an omission. EDIT is a
 * tool loop of up to six turns per clip across every clip in the video —
 * around thirty-four turns a render — and a per-minute request meter of five
 * is not a budget a tool loop can run inside. It is also the stage whose
 * whole point is spending tokens freely, which is what the qwen3 models'
 * 2M-per-day allowance is for.
 *
 * The second rung is where the stage *finishes the run*, not where it
 * retries one clip: `LadderLlmDriver`'s descent is sticky, so one failure on
 * the top rung moves every remaining clip to the second. That is the
 * operator's "fallback and continue with the rest of the work", made
 * literal.
 */
export function createEditLadder(groqLlm: LlmDriver, onEvent: (event: string) => void = (event) => console.warn(event)): LadderLlmDriver {
  return new LadderLlmDriver(
    [
      { provider: "groq", model: EDIT_MODEL, llm: groqLlm },
      { provider: "groq", model: EDIT_FALLBACK_MODEL, llm: groqLlm },
    ],
    (event) => onEvent(`EDIT: ${event}`),
  );
}
