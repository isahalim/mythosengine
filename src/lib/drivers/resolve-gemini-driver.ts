import { GeminiLlmDriver } from "./gemini.ts";
import { GeminiTtsDriver } from "./tts-gemini.ts";
import { TokenBucketLimiter } from "./rate-limiter.ts";
import type { LlmDriver, TtsDriver } from "./types.ts";
import { QUOTAS } from "../../config/quotas.ts";

/**
 * `GEMINI_API_KEY` buys exactly two things: narration, and RESEARCH's first
 * attempt (operator direction, 2026-09-02).
 *
 * Gemini briefly drove RESEARCH, reranking, SCRIPT, PLAN and EDIT
 * (2026-09-01); the operator reverted that the same day after the first
 * live run tripped the free tier's 5 requests/minute text ceiling and lost
 * a render. Five of those six stages are still on Groq permanently — see
 * `src/config/models.ts`. RESEARCH came back because it is the one stage
 * bounded by intake rather than by reasoning, and it came back under a
 * four-turn cap that cannot reach the ceiling that broke it.
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
