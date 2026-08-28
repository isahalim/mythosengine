// Typed fetch client for the /console/* routes (ARCHITECTURE.md §6),
// implemented by src/server/router.ts as of Phase 8. Every caller in
// src/console/scripts/** must still render a failed call as a real state,
// never a fabricated fallback (CLAUDE.md NEVER block) — a real backend
// existing doesn't change that discipline.
//
// Reuses the same Result<T,E>/fetchWithRetry discipline already
// established for every backend driver (src/lib/drivers/http.ts) rather
// than inventing a second HTTP layer — fetch/AbortSignal.timeout are both
// available in the browser, so the code is directly reusable here.
import { err, ok, type Result } from "../../lib/result.ts";
import { fetchWithRetry } from "../../lib/drivers/http.ts";
import type { DriverError } from "../../lib/drivers/types.ts";
import type {
  AgentTurnResult,
  ChatMessage,
  ChatSessionSummary,
  ConsoleSummary,
  DirectiveCompiled,
  DirectiveSummary,
  DryRunResult,
  ExportListItem,
  ExportStatus,
  VoiceTurnResult,
} from "./types.ts";

const READ_TIMEOUT_MS = 8_000;
const WRITE_TIMEOUT_MS = 10_000;

async function readJson<T>(res: Response): Promise<Result<T, DriverError>> {
  try {
    return ok((await res.json()) as T);
  } catch (cause) {
    return err({
      kind: "invalid_response",
      message: `Response body was not valid JSON: ${String(cause)}`,
      retryable: false,
    });
  }
}

async function get<T>(path: string): Promise<Result<T, DriverError>> {
  const res = await fetchWithRetry(
    path,
    // The Accept header is load-bearing, not decorative: /console/settings is
    // both this API route and an Astro page at the identical path
    // (src/pages/console/settings.astro) — the Worker's router
    // (src/server/router.ts) uses this header on GET to tell "the page's own
    // fetch call" apart from "a browser navigating to the page."
    { method: "GET", credentials: "same-origin", headers: { accept: "application/json" } },
    { timeoutMs: READ_TIMEOUT_MS, maxAttempts: 2, baseDelayMs: 300 },
  );
  if (!res.ok) return res;
  return readJson<T>(res.value);
}

// Mutations never retry on their own — a retried POST could double-fire a
// side effect (mark-reviewed, discard, killswitch). One attempt, hard
// timeout, the caller decides whether to let the operator retry manually.
async function send<T>(path: string, method: "POST" | "PUT" | "DELETE", body?: unknown): Promise<Result<T, DriverError>> {
  const res = await fetchWithRetry(
    path,
    {
      method,
      credentials: "same-origin",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    { timeoutMs: WRITE_TIMEOUT_MS, maxAttempts: 1, baseDelayMs: 0 },
  );
  if (!res.ok) return res;
  return readJson<T>(res.value);
}

export function getSummary(): Promise<Result<ConsoleSummary, DriverError>> {
  return get<ConsoleSummary>("/console/summary");
}

export function listExports(status?: ExportStatus): Promise<Result<ExportListItem[], DriverError>> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  return get<ExportListItem[]>(`/console/exports${qs}`);
}

export function downloadExportUrl(id: string): string {
  return `/console/exports/${encodeURIComponent(id)}/download`;
}

export function markExportReviewed(id: string): Promise<Result<{ ok: true }, DriverError>> {
  return send(`/console/exports/${encodeURIComponent(id)}/mark-reviewed`, "POST");
}

export function discardExport(id: string): Promise<Result<{ ok: true }, DriverError>> {
  return send(`/console/exports/${encodeURIComponent(id)}/discard`, "POST");
}

export function getSettings(): Promise<Result<DirectiveSummary, DriverError>> {
  return get<DirectiveSummary>("/console/settings");
}

export function putSettings(directive: DirectiveCompiled): Promise<Result<DirectiveSummary, DriverError>> {
  return send<DirectiveSummary>("/console/settings", "PUT", directive);
}

export function dryRunSettings(directive: DirectiveCompiled): Promise<Result<DryRunResult, DriverError>> {
  return send<DryRunResult>("/console/settings/dry-run", "POST", directive);
}

export function resetSettingsToDefaults(): Promise<Result<DirectiveSummary, DriverError>> {
  return send<DirectiveSummary>("/console/settings/reset-defaults", "POST");
}

export function rotateKey(name: string, value: string): Promise<Result<{ ok: true; last4: string; fingerprint: string }, DriverError>> {
  return send(`/console/keys/${encodeURIComponent(name)}`, "POST", { value });
}

export function testKey(name: string): Promise<Result<{ ok: true }, DriverError>> {
  return send(`/console/keys/${encodeURIComponent(name)}/test`, "POST");
}

export function dispatchRun(): Promise<Result<{ ok: true; runId: string }, DriverError>> {
  return send("/console/dispatch", "POST");
}

export function listChatSessions(): Promise<Result<ChatSessionSummary[], DriverError>> {
  return get<ChatSessionSummary[]>("/console/chat/sessions");
}

export function createChatSession(): Promise<Result<ChatSessionSummary, DriverError>> {
  return send<ChatSessionSummary>("/console/chat/sessions", "POST");
}

export function deleteChatSession(id: string): Promise<Result<{ ok: true }, DriverError>> {
  return send(`/console/chat/sessions/${encodeURIComponent(id)}`, "DELETE");
}

export function getChatMessages(sessionId: string): Promise<Result<ChatMessage[], DriverError>> {
  return get<ChatMessage[]>(`/console/chat/sessions/${encodeURIComponent(sessionId)}/messages`);
}

export function sendChatMessage(sessionId: string, content: string): Promise<Result<AgentTurnResult, DriverError>> {
  return send<AgentTurnResult>(`/console/chat/sessions/${encodeURIComponent(sessionId)}/message`, "POST", { content });
}

// Voice control (separate section from /console/chat — docs/DECISIONS.md's
// MCP-as-runtime-integration ADR): speech-to-text via Groq Whisper, tool
// calls dispatched through MCP, spoken replies via the browser's own
// SpeechSynthesis (no server round trip for that half).
const VOICE_TIMEOUT_MS = 20_000; // audio upload + a real Groq Whisper call is slower than a chat completion

export async function transcribeVoice(audio: Blob): Promise<Result<{ transcript: string }, DriverError>> {
  const res = await fetchWithRetry(
    "/console/voice/transcribe",
    { method: "POST", credentials: "same-origin", headers: { "content-type": audio.type || "audio/webm" }, body: audio },
    { timeoutMs: VOICE_TIMEOUT_MS, maxAttempts: 1, baseDelayMs: 0 },
  );
  if (!res.ok) return res;
  return readJson(res.value);
}

export function sendVoiceTurn(transcript: string, sessionId?: string): Promise<Result<VoiceTurnResult, DriverError>> {
  return send<VoiceTurnResult>("/console/voice/turn", "POST", { transcript, sessionId });
}

// MCP access tokens for external clients (Claude Desktop, Claude Code) —
// listed as part of getSummary() (one round trip, same as everything else
// on the dashboard); revoke only from this UI. Issuing a new token requires
// a fresh reauth nonce (CONSOLE_SPEC.md §2's bar for a credential-equivalent
// action), and the console has no step-up-reauth UI yet (same pre-existing
// gap key rotation's own UI has) — until that exists, issuing a token is a
// direct authenticated API call (see CONSOLE_SPEC.md §2), not a console button.
export function revokeMcpToken(id: string): Promise<Result<{ ok: true }, DriverError>> {
  return send(`/console/mcp-tokens/${encodeURIComponent(id)}`, "DELETE");
}

export function logout(): Promise<Result<{ ok: true }, DriverError>> {
  return send("/auth/passkey/logout", "POST");
}

export function setKillswitch(enabled: boolean): Promise<Result<{ ok: true; enabled: boolean }, DriverError>> {
  return send("/console/killswitch", "POST", { enabled });
}
