import { GeminiLlmDriver } from "./gemini.ts";
import { GeminiLadderDriver, type GeminiLadderOptions } from "./gemini-ladder.ts";
import { GeminiTtsDriver } from "./tts-gemini.ts";
import { TokenBucketLimiter } from "./rate-limiter.ts";
import type { LlmDriver, TtsDriver } from "./types.ts";
import { Vault, type VaultKv } from "../vault.ts";
import { QUOTAS } from "../../config/quotas.ts";

/** Same 90% headroom as `createGroqLimiter`, and for the same reason: the token estimate under-reads. */
const QUOTA_SAFETY_FACTOR = 0.9;

/**
 * Gemini's pacing budget, in one place.
 *
 * Note what is being paced. Gemini's *binding* limit is requests-per-day and
 * a token bucket cannot enforce a daily ceiling — that job belongs to
 * `resolveTtsDriver` (src/lib/pipeline/tts-select.ts), which counts today's
 * renders. This limiter only smooths the per-minute burst, which is what
 * keeps a multi-video run from tripping the 3 req/min ceiling on the way to
 * spending its daily allowance.
 */
export function createGeminiLimiter(): TokenBucketLimiter {
  return new TokenBucketLimiter(
    Math.max(1, Math.floor(QUOTAS.gemini.ttsRequestsPerMinute * QUOTA_SAFETY_FACTOR)),
    Math.floor(QUOTAS.gemini.ttsTokensPerMinute * QUOTA_SAFETY_FACTOR),
  );
}

/**
 * The **text** limiter, which is a different budget from the TTS one above
 * and was previously borrowing its numbers.
 *
 * That was wrong in both directions: it paced text calls at the TTS
 * model's 3 requests/minute (needlessly slow) against a 10K token/minute
 * bucket that has nothing to do with the text models' 250K/day. RESEARCH,
 * SCRIPT and PLAN all run through this one.
 *
 * There is no tokens-per-minute limit published for the text models, only
 * requests-per-minute and tokens-per-day. A token bucket cannot enforce a
 * daily ceiling, so the token dimension here is set generously and the
 * daily limit is handled where it can be: the ladder
 * (src/lib/drivers/gemini-ladder.ts) moves to a model with its own budget
 * when one is spent.
 */
export function createGeminiTextLimiter(): TokenBucketLimiter {
  return new TokenBucketLimiter(
    Math.max(1, Math.floor(QUOTAS.gemini.textRequestsPerMinute * QUOTA_SAFETY_FACTOR)),
    QUOTAS.gemini.textTokensPerDay,
  );
}

/**
 * Vault-first, env-fallback, exactly as `createGroqDriverFromVault` does it —
 * and in this file for the same reason: CLAUDE.md's NEVER block puts every
 * `vault.get()` inside `src/lib/drivers/**`.
 */
export async function createGeminiDriverFromVault(
  vaultKv: VaultKv,
  masterKeyB64: string,
  envFallbackApiKey: string,
  limiter: TokenBucketLimiter,
  testOverrides?: { baseUrl?: string; fetchImpl?: typeof fetch },
): Promise<LlmDriver> {
  const vault = new Vault(vaultKv, masterKeyB64);
  const entry = await vault.get("GEMINI_API_KEY");
  const apiKey = entry.ok && entry.value !== null ? entry.value.value : envFallbackApiKey;
  return new GeminiLlmDriver({ apiKey, limiter, ...testOverrides });
}

/** The vault-free constructor for the GitHub Actions pipeline runner, which has no binding to the console's key vault. */
export function createGeminiDriverFromEnv(apiKey: string, limiter: TokenBucketLimiter, testOverrides?: { baseUrl?: string; fetchImpl?: typeof fetch }): LlmDriver {
  return new GeminiLlmDriver({ apiKey, limiter, ...testOverrides });
}

/**
 * The driver RESEARCH, SCRIPT and PLAN actually use: the Gemini driver
 * wrapped in the model ladder.
 *
 * Constructed here rather than at the call sites so that "which models,
 * in which order, with what pacing" is answered in one file, the same way
 * `createGroqLimiter` centralizes Groq's budget.
 */
export function createGeminiLadderFromEnv(
  apiKey: string,
  options?: GeminiLadderOptions,
  testOverrides?: { baseUrl?: string; fetchImpl?: typeof fetch },
): LlmDriver {
  return new GeminiLadderDriver(new GeminiLlmDriver({ apiKey, limiter: createGeminiTextLimiter(), ...testOverrides }), options);
}

/** Likewise for narration. The daily budget is enforced by the caller, not here — see `createGeminiLimiter`. */
export function createGeminiTtsDriverFromEnv(apiKey: string, testOverrides?: { baseUrl?: string; fetchImpl?: typeof fetch }): TtsDriver {
  return new GeminiTtsDriver({ apiKey, ...testOverrides });
}
