import type { DriverError } from "./types.ts";
import { err, ok, type Result } from "../result.ts";

export interface RetryOptions {
  timeoutMs: number;
  maxAttempts: number;
  baseDelayMs: number;
  fetchImpl?: typeof fetch;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number, baseDelayMs: number): number {
  const exponential = baseDelayMs * 2 ** attempt;
  const jitter = Math.random() * baseDelayMs;
  return exponential + jitter;
}

function retryAfterMs(res: Response): number | null {
  const header = res.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

/**
 * fetch with a hard timeout, bounded retries with jitter, and retry only on
 * 429/5xx/network — never on other 4xx. Honors Retry-After when present.
 * Every driver's outbound call goes through this (ARCHITECTURE.md §3).
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: RetryOptions,
): Promise<Result<Response, DriverError>> {
  const { timeoutMs, maxAttempts, baseDelayMs, fetchImpl = fetch } = options;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const isLastAttempt = attempt === maxAttempts - 1;
    try {
      const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });

      if (res.ok) return ok(res);

      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || isLastAttempt) {
        return err({
          kind: res.status === 429 ? "rate_limited" : "provider_error",
          message: `HTTP ${res.status} from ${url}`,
          retryable,
        });
      }

      const delay = retryAfterMs(res) ?? backoffMs(attempt, baseDelayMs);
      await sleep(delay);
    } catch (cause) {
      const isAbort = cause instanceof Error && cause.name === "TimeoutError";
      if (isLastAttempt) {
        return err({
          kind: isAbort ? "timeout" : "network",
          message: cause instanceof Error ? cause.message : String(cause),
          retryable: true,
        });
      }
      await sleep(backoffMs(attempt, baseDelayMs));
    }
  }

  /* v8 ignore next 2 -- unreachable: the loop always returns on its last attempt, TS just can't prove it */
  return err({ kind: "network", message: "retry loop exited unexpectedly", retryable: true });
}
