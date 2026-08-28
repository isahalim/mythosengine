// Typed fetch client for the /console/* routes (ARCHITECTURE.md §6). The
// Worker doesn't serve these yet (Phase 8) — every call here is expected to
// fail honestly against today's dev server, and every caller in
// src/console/scripts/** must render that failure as a real state, never a
// fabricated fallback (CLAUDE.md NEVER block).
//
// Reuses the same Result<T,E>/fetchWithRetry discipline already
// established for every backend driver (src/lib/drivers/http.ts) rather
// than inventing a second HTTP layer — fetch/AbortSignal.timeout are both
// available in the browser, so the code is directly reusable here.
import { err, ok, type Result } from "../../lib/result.ts";
import { fetchWithRetry } from "../../lib/drivers/http.ts";
import type { DriverError } from "../../lib/drivers/types.ts";
import type {
  ConsoleSummary,
  DirectiveCompiled,
  DirectiveSummary,
  DryRunResult,
  ExportListItem,
  ExportStatus,
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
    { method: "GET", credentials: "same-origin" },
    { timeoutMs: READ_TIMEOUT_MS, maxAttempts: 2, baseDelayMs: 300 },
  );
  if (!res.ok) return res;
  return readJson<T>(res.value);
}

// Mutations never retry on their own — a retried POST could double-fire a
// side effect (mark-reviewed, discard, killswitch). One attempt, hard
// timeout, the caller decides whether to let the operator retry manually.
async function send<T>(path: string, method: "POST" | "PUT", body?: unknown): Promise<Result<T, DriverError>> {
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

export function setKillswitch(enabled: boolean): Promise<Result<{ ok: true; enabled: boolean }, DriverError>> {
  return send("/console/killswitch", "POST", { enabled });
}
