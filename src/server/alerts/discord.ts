import { err, ok, type Result } from "../../lib/result.ts";
import type { DriverError } from "../../lib/drivers/types.ts";

/**
 * AGENT_PLAYBOOK.md Phase 8 / Part IV: a Discord webhook alert on AUDIT
 * SUMMARY flag rate > 20%/24h (informational), Edge TTS failing 2 runs in a
 * row ("the free ride ended" alarm), a KV export write failure, or any
 * stage failing 3 runs running. This posts a single message; the caller
 * decides which condition fired and what `message` says.
 */
export async function postAlert(webhookUrl: string, message: string, fetchImpl: typeof fetch = fetch): Promise<Result<void, DriverError>> {
  try {
    const res = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: message }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      return err({ kind: "provider_error", message: `Discord webhook returned HTTP ${res.status}`, retryable: res.status >= 500 });
    }
    return ok(undefined);
  } catch (cause) {
    const isAbort = cause instanceof Error && cause.name === "TimeoutError";
    return err({ kind: isAbort ? "timeout" : "network", message: cause instanceof Error ? cause.message : String(cause), retryable: true });
  }
}
