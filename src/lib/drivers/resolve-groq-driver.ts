import { GroqLlmDriver } from "./groq.ts";
import type { TokenBucketLimiter } from "./rate-limiter.ts";
import type { LlmDriver } from "./types.ts";
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
