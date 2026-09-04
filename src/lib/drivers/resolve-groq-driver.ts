import { GroqLlmDriver } from "./groq.ts";
import { GroqWhisperDriver } from "./groq-whisper.ts";
import { TokenBucketLimiter } from "./rate-limiter.ts";
import type { AsrDriver, LlmDriver } from "./types.ts";
import { Vault, type VaultKv } from "../vault.ts";
import { QUOTAS } from "../../config/quotas.ts";

/**
 * Pace at 90% of the published ceiling. The headroom is not superstition:
 * `estimatePromptTokens` (groq.ts) is a chars/4 floor that under-reads
 * JSON-heavy tool traffic, so the bucket is always slightly optimistic
 * about what a request will actually cost.
 */
const QUOTA_SAFETY_FACTOR = 0.9;

/**
 * The one place Groq's pacing budget is decided. All three call sites — the
 * Worker's chat/voice agent, the render pipeline, and the weekly footage
 * agent — previously hard-coded their own pair of numbers, and all three had
 * drifted from `QUOTAS` and from each other (28/4500 and 30/6000 against a
 * real limit of 30/8000). Deriving them here means correcting the quota in
 * one file corrects every limiter.
 *
 * Note what this can and cannot do: in the Worker each isolate gets its own
 * bucket, so this paces a single isolate's traffic, not the account's. It
 * reduces 429s; it cannot eliminate them, which is why http.ts must handle
 * a 429 correctly rather than relying on never seeing one.
 */
export function createGroqLimiter(): TokenBucketLimiter {
  return new TokenBucketLimiter(
    Math.floor(QUOTAS.groq.requestsPerMinute * QUOTA_SAFETY_FACTOR),
    // The lowest input ceiling any model on this account enforces, not the
    // highest. One limiter paces every Groq stage in a render and the
    // stages are no longer all on one model: gpt-oss allows 8,000 input
    // tokens a minute and the qwen3 models EDIT runs on allow 7,000
    // (measured 2026-09-04, off the refusal itself — their own response
    // header still advertises 8,000). A bucket sized on the larger figure
    // paces EDIT straight into a 429 it thought it had room for.
    Math.floor(Math.min(QUOTAS.groq.tokensPerMinute, QUOTAS.groq.inputTokensPerMinuteQwen3) * QUOTA_SAFETY_FACTOR),
  );
}

/**
 * The one production call site of `vault.get()` (CLAUDE.md NEVER block:
 * "never let vault.get() be called outside src/lib/drivers/**"). Reads the
 * live, rotatable GROQ_API_KEY from the vault; falls back to the Worker
 * secret env var only when the operator hasn't rotated a key into the vault
 * yet (first run after provisioning, before CONSOLE_SPEC.md §2's rotation
 * flow has ever been used).
 */
export async function createGroqDriverFromVault(
  vaultKv: VaultKv,
  masterKeyB64: string,
  envFallbackApiKey: string,
  limiter: TokenBucketLimiter,
  testOverrides?: { baseUrl?: string; fetchImpl?: typeof fetch },
): Promise<LlmDriver> {
  const vault = new Vault(vaultKv, masterKeyB64);
  const entry = await vault.get("GROQ_API_KEY");
  const apiKey = entry.ok && entry.value !== null ? entry.value.value : envFallbackApiKey;
  return new GroqLlmDriver({ apiKey, limiter, ...testOverrides });
}

/**
 * A vault-free constructor for callers with no Worker KV/vault available at
 * all — the GitHub Actions pipeline runner (scripts/pipeline/**), which has
 * no binding to the console's key vault. Keeps driver construction
 * centralized in src/lib/drivers/** (this file, not the orchestrator
 * scripts) per the same convention createGroqDriverFromVault follows, even
 * though there's no vault.get() call here to restrict.
 */
export function createGroqDriverFromEnv(apiKey: string, limiter: TokenBucketLimiter, testOverrides?: { baseUrl?: string; fetchImpl?: typeof fetch }): LlmDriver {
  return new GroqLlmDriver({ apiKey, limiter, maxRetryDelayMs: PIPELINE_MAX_RETRY_DELAY_MS, ...testOverrides });
}

/**
 * How long the **pipeline's** Groq driver may wait out a 429, against
 * `fetchWithRetry`'s 5s default.
 *
 * The default is right for the Worker, which has to answer a request. It is
 * wrong here for the same reason the Ideas refresh's rule is right there:
 * what a caller may do about a per-minute meter is decided by the budget it
 * is running inside, and this one is a GitHub Actions job with
 * `timeout-minutes: 180`. A 429 that says "try again in 15s" is a 15-second
 * wait, not a failure — and treating it as a failure is what cost the
 * 2026-09-04 render six of its eight clips: EDIT met the qwen3 **output**
 * meter, `Retry-After 10s exceeds the 5s retry budget` turned it into a
 * `rate_limited` error, `LadderLlmDriver` spent both rungs on it inside 70
 * seconds, and shots 3 through 7 were abandoned without a request being
 * made for any of them. Every `Retry-After` measured on that meter that day
 * — 1.4s, 10s, 15s, 41.8s, 44.8s — fits inside a minute.
 *
 * This is a ceiling on one sleep, not a total: `maxAttempts` still bounds
 * how many of them a request may make, and a meter that is still refusing
 * after that still surfaces as `rate_limited` and still descends the ladder.
 * What changes is that a wait the job could afford is now taken.
 */
const PIPELINE_MAX_RETRY_DELAY_MS = 60_000;

/** Same vault-first/env-fallback resolution as createGroqDriverFromVault, for the voice surface's speech-to-text call (src/lib/drivers/groq-whisper.ts). */
export async function createGroqWhisperDriverFromVault(
  vaultKv: VaultKv,
  masterKeyB64: string,
  envFallbackApiKey: string,
  testOverrides?: { baseUrl?: string; fetchImpl?: typeof fetch },
): Promise<AsrDriver> {
  const vault = new Vault(vaultKv, masterKeyB64);
  const entry = await vault.get("GROQ_API_KEY");
  const apiKey = entry.ok && entry.value !== null ? entry.value.value : envFallbackApiKey;
  return new GroqWhisperDriver({ apiKey, ...testOverrides });
}
