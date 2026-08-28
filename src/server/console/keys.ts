import { z } from "zod";
import { Vault, type VaultKv } from "../../lib/vault.ts";
import { fetchWithRetry } from "../../lib/drivers/http.ts";
import type { DriverError } from "../../lib/drivers/types.ts";
import { ok, type Result } from "../../lib/result.ts";

export const ROTATABLE_KEY_NAMES = ["GROQ_API_KEY", "YOUTUBE_API_KEY"] as const;
export type RotatableKeyName = (typeof ROTATABLE_KEY_NAMES)[number];

const SHAPE_VALIDATORS: Record<RotatableKeyName, z.ZodString> = {
  GROQ_API_KEY: z.string().regex(/^gsk_[A-Za-z0-9]{40,}$/, "Groq keys look like gsk_<40+ alphanumeric chars>"),
  // YouTube's read-only API key is an opaque string — shape is validated by the live check instead (CONSOLE_SPEC.md §2).
  YOUTUBE_API_KEY: z.string().min(20),
};

/** CONSOLE_SPEC.md §2 step 3: call the provider with the candidate credential; a live 200 is the only thing that validates it. */
async function liveCheck(name: RotatableKeyName, candidate: string, fetchImpl?: typeof fetch): Promise<Result<void, DriverError>> {
  if (name === "GROQ_API_KEY") {
    const result = await fetchWithRetry(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${candidate}` },
        body: JSON.stringify({ model: "llama-3.1-8b-instant", messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
      },
      { timeoutMs: 8_000, maxAttempts: 1, baseDelayMs: 0, fetchImpl },
    );
    return result.ok ? ok(undefined) : result;
  }

  // YOUTUBE_API_KEY: a cheap, well-known public channels.list read.
  const result = await fetchWithRetry(
    `https://www.googleapis.com/youtube/v3/channels?part=id&id=UC_x5XG1OV2P6uZZ5FSM9Ttw&key=${encodeURIComponent(candidate)}`,
    { method: "GET" },
    { timeoutMs: 8_000, maxAttempts: 1, baseDelayMs: 0, fetchImpl },
  );
  return result.ok ? ok(undefined) : result;
}

export type RotateKeyResult =
  | { kind: "ok"; last4: string; fingerprint: string; activeVersion: number }
  | { kind: "invalid_shape"; message: string }
  | { kind: "live_check_failed"; error: DriverError };

/**
 * CONSOLE_SPEC.md §2's full rotation flow, steps 2-8 (step 1 — session +
 * reauth — is enforced by the route before this is ever called). Nothing
 * is written to the vault unless the live check against the real provider
 * succeeds first.
 */
export async function rotateProviderKey(
  vaultKv: VaultKv,
  masterKeyB64: string,
  name: RotatableKeyName,
  candidate: string,
  fetchImpl?: typeof fetch,
): Promise<RotateKeyResult> {
  const shape = SHAPE_VALIDATORS[name].safeParse(candidate);
  if (!shape.success) return { kind: "invalid_shape", message: shape.error.issues[0]?.message ?? "invalid key shape" };

  const checked = await liveCheck(name, candidate, fetchImpl);
  if (!checked.ok) return { kind: "live_check_failed", error: checked.error };

  const vault = new Vault(vaultKv, masterKeyB64);
  const rotated = await vault.rotate(name, candidate);
  if (!rotated.ok) return { kind: "live_check_failed", error: rotated.error };

  return { kind: "ok", last4: rotated.value.last4, fingerprint: rotated.value.fingerprint, activeVersion: rotated.value.version };
}
