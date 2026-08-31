import { GeminiLlmDriver } from "./gemini.ts";
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

/** Likewise for narration. The daily budget is enforced by the caller, not here — see `createGeminiLimiter`. */
export function createGeminiTtsDriverFromEnv(apiKey: string, testOverrides?: { baseUrl?: string; fetchImpl?: typeof fetch }): TtsDriver {
  return new GeminiTtsDriver({ apiKey, ...testOverrides });
}
