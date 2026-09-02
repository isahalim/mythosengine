/**
 * Typed fetch client for the /console/* routes (ARCHITECTURE.md §6).
 *
 * Reuses the same Result<T,E>/fetchWithRetry discipline every backend
 * driver already uses (src/lib/drivers/http.ts) rather than inventing a
 * second HTTP layer — fetch and AbortSignal.timeout both exist in the
 * browser, so the code is directly reusable.
 *
 * Every caller must render a failed call as a real state, never as
 * fabricated fallback data (CLAUDE.md NEVER block).
 */
import { err, ok, type Result } from "../lib/result.ts";
import { fetchWithRetry } from "../lib/drivers/http.ts";
import type { DriverError } from "../lib/drivers/types.ts";
import type { ExportListItem, ExportMetadata, ExportPreviews, ExportStatus, QueuedPickView, RankedIdea, RunMontage, RunProgress, Topic } from "./types.ts";

const READ_TIMEOUT_MS = 8_000;
const WRITE_TIMEOUT_MS = 10_000;

async function readJson<T>(res: Response): Promise<Result<T, DriverError>> {
  try {
    return ok((await res.json()) as T);
  } catch (cause) {
    return err({ kind: "invalid_response", message: `Response body was not valid JSON: ${String(cause)}`, retryable: false });
  }
}

async function get<T>(path: string, timeoutMs = READ_TIMEOUT_MS): Promise<Result<T, DriverError>> {
  const res = await fetchWithRetry(
    path,
    // The Accept header is load-bearing, not decorative: the router uses it
    // on GET to tell an API call apart from a browser navigation, which it
    // has to pass through to the static asset handler instead.
    { method: "GET", credentials: "same-origin", headers: { accept: "application/json" } },
    { timeoutMs, maxAttempts: 2, baseDelayMs: 300 },
  );
  if (!res.ok) return res;
  return readJson<T>(res.value);
}

// Mutations never retry on their own — a retried POST could double-fire a
// side effect (queue a plan twice, discard, dispatch). One attempt, hard
// timeout, and the caller decides whether to offer a manual retry.
async function send<T>(path: string, method: "POST" | "DELETE", body?: unknown): Promise<Result<T, DriverError>> {
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

/** True when a failed call failed because there is no valid session — a completely different, actionable situation from the API being down. */
export function isUnauthorized(error: DriverError): boolean {
  return error.message.startsWith("HTTP 401");
}

/**
 * A DriverError's message carries the response body, which is right for a
 * log and wrong for a stage: a route that answers with an HTML error page
 * put several hundred characters of markup on screen where a sentence
 * belonged.
 *
 * This shortens it. It does NOT replace it with a friendlier fiction —
 * the status line and the start of whatever the server actually said both
 * survive, because "HTTP 502 upstream timeout" is the thing that tells the
 * operator whether to retry or to go and look at the Worker.
 */
export function describeError(error: DriverError): string {
  const flattened = error.message.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return flattened.length > 160 ? `${flattened.slice(0, 157)}…` : flattened;
}

/** Ranked candidates for one topic. `exclude` carries picks already made in this run; the server also excludes anything already queued. */
export function listIdeas(topic: Topic, limit = 5, exclude: string[] = []): Promise<Result<RankedIdea[], DriverError>> {
  const params = new URLSearchParams({ topic, limit: String(limit) });
  if (exclude.length > 0) params.set("exclude", exclude.join(","));
  return get<RankedIdea[]>(`/console/ideas?${params.toString()}`);
}

export function getRunPlan(): Promise<Result<QueuedPickView[], DriverError>> {
  return get<QueuedPickView[]>("/console/run-plan");
}

export function submitRunPlan(picks: { topic: Topic; signalId: string }[]): Promise<Result<{ ok: true; planId: string; queued: number }, DriverError>> {
  return send("/console/run-plan", "POST", { picks });
}

export function cancelRunPick(id: string): Promise<Result<{ ok: true }, DriverError>> {
  return send(`/console/run-plan/${encodeURIComponent(id)}`, "DELETE");
}

/** `note` is set when the run was recorded but not actually triggered (src/server/console/dispatch.ts). Stage 5 shows it verbatim. */
export function dispatchRun(): Promise<Result<{ ok: true; runId: string; note?: string }, DriverError>> {
  return send("/console/dispatch", "POST");
}

export function getRunProgress(traceId: string): Promise<Result<RunProgress, DriverError>> {
  return get<RunProgress>(`/console/runs/${encodeURIComponent(traceId)}`);
}

// Reaches Pexels server-side (cached per keyword for a day), so it gets a
// longer budget than a D1 read — a montage that timed out client-side would
// look like a run with no keywords rather than a slow network.
export function getRunMontage(traceId: string): Promise<Result<RunMontage, DriverError>> {
  return get<RunMontage>(`/console/runs/${encodeURIComponent(traceId)}/montage`, 15_000);
}

export function listExports(status?: ExportStatus): Promise<Result<ExportListItem[], DriverError>> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  return get<ExportListItem[]>(`/console/exports${qs}`);
}

// Reaches Pexels server-side for every live export's keywords, so it gets
// the montage's longer budget rather than a D1 read's. Cached per keyword
// for a day and shared with the run montage, so a second visit to stage 6
// usually spends no request at all.
export function listExportPreviews(): Promise<Result<ExportPreviews, DriverError>> {
  return get<ExportPreviews>("/console/exports/previews", 15_000);
}

/**
 * The upload sheet for one finished video: description, hashtags, and every
 * clip with the source and span it came from.
 *
 * Fetched per export on demand rather than folded into the list — it
 * carries the whole footage track and is read for one video at a time.
 */
export function getExportMetadata(id: string): Promise<Result<ExportMetadata, DriverError>> {
  return get<ExportMetadata>(`/console/exports/${encodeURIComponent(id)}/metadata`);
}

/** A plain <a href>, never a fetch: the route answers video/mp4 with a Content-Disposition attachment. */
export function downloadExportUrl(id: string): string {
  return `/console/exports/${encodeURIComponent(id)}/download`;
}

export function markExportReviewed(id: string): Promise<Result<{ ok: true }, DriverError>> {
  return send(`/console/exports/${encodeURIComponent(id)}/mark-reviewed`, "POST");
}

export function discardExport(id: string): Promise<Result<{ ok: true }, DriverError>> {
  return send(`/console/exports/${encodeURIComponent(id)}/discard`, "POST");
}

export function logout(): Promise<Result<{ ok: true }, DriverError>> {
  return send("/auth/passkey/logout", "POST");
}
