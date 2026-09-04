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
 * post-Gemini fallback (operator direction, 2026-09-04).
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
 * The general ladder with its Gemini rung removed — **gpt-oss-120b →
 * gpt-oss-20b**, and nothing above them.
 *
 * This exists for exactly one caller: RESEARCH's fallback. RESEARCH already
 * spent its Gemini attempt, on its own model and its own four-turn budget,
 * before anything reaches here (src/lib/rag/research-provider.ts), and
 * splicing `GEMINI_REASONING_MODEL` in above these two would give that one
 * stage a second Gemini attempt — the thing the operator ruled out on
 * 2026-09-02 and CLAUDE.md's NEVER block records. Every other stage on the
 * general ladder gets the Gemini rung from `createReasoningLadders`.
 */
export function createGroqReasoningLadder(groqLlm: LlmDriver, stage: string, onEvent: (event: string) => void = (event) => console.warn(event)): LadderLlmDriver {
  return new LadderLlmDriver(groqReasoningRungs(groqLlm), (event) => onEvent(`${stage}: ${event}`));
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
