import { GroqLlmDriver } from "./groq.ts";
import { GroqWhisperDriver } from "./groq-whisper.ts";
import type { TokenBucketLimiter } from "./rate-limiter.ts";
import type { AsrDriver, LlmDriver } from "./types.ts";
import { Vault, type VaultKv } from "../vault.ts";

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
