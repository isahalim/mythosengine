import { GeminiLlmDriver } from "./gemini.ts";
import { GeminiTtsDriver } from "./tts-gemini.ts";
import { TokenBucketLimiter } from "./rate-limiter.ts";
import type { LlmDriver, TtsDriver } from "./types.ts";
import { QUOTAS } from "../../config/quotas.ts";

/**
 * `GEMINI_API_KEY` buys three things: narration, RESEARCH's first attempt
 * (operator direction, 2026-09-02), and the **top rung** of the general
 * reasoning ladder — SCRIPT, PLAN and reranking (operator direction,
 * 2026-09-04).
 *
 * Gemini briefly drove RESEARCH, reranking, SCRIPT, PLAN and EDIT
 * (2026-09-01) and the operator reverted that the same day, after the first
 * live run tripped the free tier's 5 requests/minute text ceiling and lost a
 * render. The 2026-09-04 arrangement is not that one returning, and the
 * difference is the whole of why it is safe: those stages *depended* on
 * Gemini, behind a fallback that fired only on quota exhaustion, so two
 * `500 InternalServerError`s killed the render at SCRIPT. They now sit on a
 * `LadderLlmDriver` that steps down to Groq on **any** failure and has two
 * known-good Groq rungs beneath it. And they are on a different model id
 * from RESEARCH's — the meter is per model, so the two never share a
 * bucket.
 *
 * Absent the key, none of the three happens and every path is the Groq or
 * Edge one, unslowed. An upgrade must not become a dependency; it was one
 * for a few hours on 2026-09-01 and that is the only time this system has
 * lost a render to a provider it did not need.
 *
 * The `createGeminiLimiter` that used to live here is still gone: it paced
 * a per-minute burst the TTS driver never takes (one call per video), and
 * the limit that actually binds narration is the daily one, enforced by
 * `resolveTtsDriver` (src/lib/pipeline/tts-select.ts) counting today's
 * renders. `createGeminiTextLimiter` below is a different budget entirely.
 */

/** Same 90% headroom as `createGroqLimiter`, and for the same reason: the token estimate under-reads. */
const QUOTA_SAFETY_FACTOR = 0.9;

/**
 * The **text** limiter, which is a different budget from narration's.
 *
 * It is deliberately not what keeps a render legal. RESEARCH's Gemini
 * attempt is capped at four turns against a five-per-minute ceiling
 * (`GEMINI_RESEARCH_MAX_ITERATIONS`), so within one render there is nothing
 * for this to pace — the bucket starts full and every turn passes straight
 * through. What it catches is the case the cap cannot see: two renders
 * dispatched inside the same minute, where the second process starts with a
 * fresh bucket while Google's window still holds the first's requests.
 *
 * The token dimension is the daily figure rather than a per-minute one
 * because Gemini publishes no per-minute token limit for the text models. A
 * bucket cannot enforce a daily ceiling, so it is set wide and the real
 * daily protection is that only one stage of one render ever calls this.
 */
export function createGeminiTextLimiter(): TokenBucketLimiter {
  return new TokenBucketLimiter(
    Math.max(1, Math.floor(QUOTAS.gemini.textRequestsPerMinute * QUOTA_SAFETY_FACTOR)),
    QUOTAS.gemini.textTokensPerDay,
  );
}

/**
 * How long one turn of RESEARCH's Gemini attempt may take.
 *
 * **Not the driver's 60s default, because `GEMINI_RESEARCH_MODEL` does not
 * answer inside it.** Measured against the live Interactions endpoint on
 * 2026-09-04, on a request the size RESEARCH actually sends (a tool
 * definition and ~16K characters of source text): **28.8s, 54.4s and
 * 144.9s**, all three HTTP 200. A trivial "reply OK" against the same model
 * measured 12s, 30.5s and 61.2s. The spread, not the median, is the number
 * that matters — at 60s the majority of real turns are aborted mid-answer,
 * which is exactly what the first live run of this arrangement did: the
 * attempt timed out and the render was researched by the fallback's Flash
 * Lite rung instead. A model the operator chose that structurally never
 * answers is the direction implemented in name only.
 *
 * This is the Gemini TTS lesson of 2026-09-02 in a second place: a flat
 * timeout below the measured cost of an ordinary request does not degrade,
 * it *deletes* the path it guards, quietly, while every test passes.
 *
 * 180s is above the worst observed turn with room, and the attempt is capped
 * at four turns (`GEMINI_RESEARCH_MAX_ITERATIONS`), so the worst case this
 * can cost a render is about twelve minutes before it gives up and the
 * fallback — which measured 6.5s a turn on Flash Lite — takes over. Against
 * `render.yml`'s 180-minute job that is affordable; against a 60s timeout
 * that never lets the model finish, it is the only way this stage runs on
 * the model it is configured to run on.
 */
const GEMINI_RESEARCH_TIMEOUT_MS = 180_000;

/**
 * RESEARCH's Gemini driver: **one attempt, no retries**.
 *
 * `maxAttempts: 1` is the operator's "once", enforced at the only place it
 * can be. Without it `fetchWithRetry` would retry a 429 or a 500 twice more
 * before giving up, and every one of those is charged against a
 * five-per-minute window that a retry cannot outrun — the same lesson the
 * Gemini TTS path learned on 2026-09-01, when retrying a daily-quota 429
 * spent an eleventh request to learn the same thing twice. Here a retry is
 * also simply unnecessary: Groq is one function call away and is not rate
 * limited on this axis, so the cheapest response to any failure is to stop
 * asking Gemini.
 */
export function createGeminiResearchDriverFromEnv(
  apiKey: string,
  testOverrides?: { baseUrl?: string; fetchImpl?: typeof fetch },
): LlmDriver {
  return new GeminiLlmDriver({ apiKey, limiter: createGeminiTextLimiter(), maxAttempts: 1, timeoutMs: GEMINI_RESEARCH_TIMEOUT_MS, ...testOverrides });
}

/**
 * The reasoning ladder's Gemini rung: **one shared instance, one attempt, no
 * retries** (operator direction, 2026-09-04).
 *
 * *Shared, because the meter is.* Gemini bills 5 requests/minute per model,
 * and SCRIPT, PLAN and reranking are three stages spending against one
 * `GEMINI_REASONING_MODEL` bucket within about a minute of each other. Each
 * stage gets its own `LadderLlmDriver` — so one stage's descent does not
 * decide where the next starts — but every one of those ladders must hold
 * *this same driver*, or three private limiters would each believe they had
 * the whole allowance and the three of them together would ask for eight
 * requests a minute. `createReasoningLadders` is what enforces that.
 *
 * *One attempt, for the same reason RESEARCH's driver takes one.* A retry
 * here is charged against a per-minute window it cannot outrun, and Groq is
 * one rung down and is not rate limited on this axis. The cheapest response
 * to any failure is to stop asking Gemini.
 *
 * *And the 60s default timeout, unlike RESEARCH's.* `GEMINI_REASONING_MODEL`
 * measured 6.5s on a comparable request on 2026-09-04, an order of magnitude
 * under the ceiling, so there is nothing here to raise — and this rung sits
 * under SCRIPT and PLAN, which have two Groq rungs beneath them and no
 * reason to wait three minutes before using one.
 */
export function createGeminiReasoningDriverFromEnv(
  apiKey: string,
  testOverrides?: { baseUrl?: string; fetchImpl?: typeof fetch },
): LlmDriver {
  return new GeminiLlmDriver({ apiKey, limiter: createGeminiTextLimiter(), maxAttempts: 1, ...testOverrides });
}

/**
 * The vault-free constructor for the GitHub Actions pipeline runner, which
 * has no binding to the console's key vault. Kept in `src/lib/drivers/**`
 * for the same convention `createGroqDriverFromEnv` follows: driver
 * construction lives here, not in the orchestrator scripts.
 */
export function createGeminiTtsDriverFromEnv(apiKey: string, testOverrides?: { baseUrl?: string; fetchImpl?: typeof fetch }): TtsDriver {
  return new GeminiTtsDriver({ apiKey, ...testOverrides });
}
