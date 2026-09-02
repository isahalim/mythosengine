import type { DriverError } from "./types.ts";
import { err, ok, type Result } from "../result.ts";

export interface RetryOptions {
  timeoutMs: number;
  maxAttempts: number;
  baseDelayMs: number;
  fetchImpl?: typeof fetch;
  /**
   * Longest this will ever sleep between attempts, including a sleep a
   * server asked for via `Retry-After`. A 429 whose `Retry-After` exceeds
   * this is returned as `rate_limited` immediately instead of being waited
   * out — see the comment on `retryAfterMs` for why that is not optional.
   */
  maxRetryDelayMs?: number;
  /**
   * Whether a 429 is worth trying again. Default true, which is right for
   * a per-minute throttle: waiting a second and asking again is exactly
   * what the server asked for.
   *
   * It is wrong for a *daily* quota, where the second attempt cannot
   * succeed before the quota resets and is itself charged against it.
   * Gemini's free TTS tier allows ten requests a day, so the retry that
   * followed the 429 on 2026-09-01 spent an eleventh — a retry that could
   * only ever deepen the hole it was digging out of. `tts-gemini.ts` sets
   * this false for that reason.
   */
  retryOn429?: boolean;
}

/**
 * Ceiling on the provider error body kept on `DriverError.responseBody`.
 * Big enough for a Groq `failed_generation` (a whole model turn); small
 * enough that a provider answering a 4xx with a megabyte of HTML cannot
 * push it into a log line or a KV value.
 */
const MAX_ERROR_BODY_CHARS = 16_384;

/**
 * Ceiling on any single inter-attempt sleep. A caller that hasn't thought
 * about it gets 5s, which is short enough to stay inside a Cloudflare
 * Workers request and inside the console's own client-side budgets.
 */
const DEFAULT_MAX_RETRY_DELAY_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number, baseDelayMs: number): number {
  const exponential = baseDelayMs * 2 ** attempt;
  const jitter = Math.random() * baseDelayMs;
  return exponential + jitter;
}

/**
 * `Retry-After`, in milliseconds, or null when absent/unparseable.
 *
 * **The caller must bound this before sleeping on it.** It is a value a
 * remote server chooses, and Groq's token-per-minute 429s routinely ask for
 * a wait measured in tens of seconds. Sleeping that long inside a
 * request-scoped handler doesn't produce a slow response, it produces no
 * response: on 2026-08-29 a console chat turn hit a Groq TPM 429, this
 * function returned a delay longer than the request had left, the Worker
 * was killed mid-sleep, and the turn died without persisting anything — so
 * the operator saw a generic `provider_error` and an answer that never
 * arrived, with no trace of a rate limit anywhere in the chat history.
 * Returning `rate_limited` promptly is strictly more useful than waiting:
 * it is true, it is fast, and it is something the UI can explain.
 */
/**
 * Providers report *which* limit a 429 hit, and how much of it is left, in
 * `x-ratelimit-*` response headers — Groq sends separate request- and
 * token-scoped ones with their own reset intervals. Discarding them turns
 * every throttle into an indistinguishable "rate_limited", which on
 * 2026-08-29 cost real time: a per-minute token limit and a per-day token
 * limit produce identical errors, respond to completely different fixes
 * (wait a minute vs. cut the payload or wait hours), and were told apart
 * only by inference from `Retry-After` values. Folding the headers into the
 * error message makes the next occurrence self-diagnosing.
 */
function describeRateLimitHeaders(res: Response): string {
  const parts: string[] = [];
  res.headers.forEach((value, name) => {
    if (name.toLowerCase().startsWith("x-ratelimit-")) parts.push(`${name}=${value}`);
  });
  return parts.length > 0 ? ` [${parts.sort().join(", ")}]` : "";
}

/**
 * The provider's own explanation of a 4xx, folded into the error message.
 *
 * A 400 means the *request* was wrong, and the body is the only thing that
 * says how — an unknown model id, a rejected parameter, a malformed message.
 * Discarding it turns every one of those into an identical
 * `HTTP 400 from https://api.groq.com/...`, which is exactly as useful as no
 * error at all. On 2026-08-31 both RESEARCH and SCRIPT failed that way and
 * the run could not say why.
 *
 * Bounded, and only read on the failure path — the success path never touches
 * the body. Provider error bodies describe the request we sent, not our
 * credentials: the key travels in a header and is never echoed back.
 */
async function readErrorBody(res: Response): Promise<string> {
  if (res.status < 400 || res.status >= 500) return "";
  try {
    return (await res.text()).replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_BODY_CHARS);
  } catch {
    // The status is the finding; a body we could not read does not change it.
    return "";
  }
}

function retryAfterMs(res: Response): number | null {
  const header = res.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
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
  const { timeoutMs, maxAttempts, baseDelayMs, fetchImpl = fetch, maxRetryDelayMs = DEFAULT_MAX_RETRY_DELAY_MS, retryOn429 = true } = options;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const isLastAttempt = attempt === maxAttempts - 1;
    try {
      const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });

      // 304 is a valid, meaningful outcome for a conditional GET (ETag/
      // If-Modified-Since) — not an error, and Response.ok is false for it.
      if (res.ok || res.status === 304) return ok(res);

      const retryable = (res.status === 429 && retryOn429) || res.status >= 500;
      const requestedDelay = retryAfterMs(res);
      // Waiting longer than the budget allows is not a retry, it's a hang
      // that the runtime eventually kills — report the rate limit instead.
      const waitTooLong = requestedDelay !== null && requestedDelay > maxRetryDelayMs;
      if (!retryable || isLastAttempt || waitTooLong) {
        const limitDetail = res.status === 429 ? describeRateLimitHeaders(res) : "";
        const body = await readErrorBody(res);
        return err({
          kind: res.status === 429 ? "rate_limited" : "provider_error",
          message:
            waitTooLong && res.status === 429
              ? `HTTP 429 from ${url}; Retry-After ${Math.round(requestedDelay / 1000)}s exceeds the ${Math.round(maxRetryDelayMs / 1000)}s retry budget${limitDetail}`
              : `HTTP ${res.status} from ${url}${limitDetail}${body.length > 0 ? `: ${body.slice(0, 400)}` : ""}`,
          // `retryable` says whether *anyone* should try again, so a 429 stays
          // retryable-in-principle even where this call declined to retry it.
          retryable: res.status === 429 || res.status >= 500,
          ...(body.length > 0 ? { responseBody: body } : {}),
        });
      }

      await sleep(Math.min(requestedDelay ?? backoffMs(attempt, baseDelayMs), maxRetryDelayMs));
    } catch (cause) {
      const isAbort = cause instanceof Error && cause.name === "TimeoutError";
      if (isLastAttempt) {
        return err({
          kind: isAbort ? "timeout" : "network",
          message: cause instanceof Error ? cause.message : String(cause),
          retryable: true,
        });
      }
      await sleep(Math.min(backoffMs(attempt, baseDelayMs), maxRetryDelayMs));
    }
  }

  /* v8 ignore next 2 -- unreachable: the loop always returns on its last attempt, TS just can't prove it */
  return err({ kind: "network", message: "retry loop exited unexpectedly", retryable: true });
}
