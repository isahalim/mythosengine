/**
 * Dual token-bucket limiter: caps both requests/minute and tokens/minute.
 * A single shared instance is meant to serialize every Groq draft call
 * process-wide (ARCHITECTURE.md §9) — `acquire()` calls are queued FIFO so
 * two callers never interleave their waits and both jump the bucket at once.
 */
export class TokenBucketLimiter {
  private requestCapacity: number;
  private tokenCapacity: number;
  private requestTokens: number;
  private tokenBudget: number;
  private lastRefillMs: number;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private requestsPerMinute: number,
    private tokensPerMinute: number,
    private now: () => number = Date.now,
  ) {
    this.requestCapacity = requestsPerMinute;
    this.tokenCapacity = tokensPerMinute;
    this.requestTokens = requestsPerMinute;
    this.tokenBudget = tokensPerMinute;
    this.lastRefillMs = this.now();
  }

  private refill(): void {
    const nowMs = this.now();
    const elapsedMs = Math.max(0, nowMs - this.lastRefillMs);
    if (elapsedMs === 0) return;
    this.requestTokens = Math.min(
      this.requestCapacity,
      this.requestTokens + (elapsedMs / 60_000) * this.requestsPerMinute,
    );
    this.tokenBudget = Math.min(this.tokenCapacity, this.tokenBudget + (elapsedMs / 60_000) * this.tokensPerMinute);
    this.lastRefillMs = nowMs;
  }

  private msUntilAvailable(estimatedTokens: number): number {
    this.refill();
    const msForRequest = this.requestTokens >= 1 ? 0 : ((1 - this.requestTokens) / this.requestsPerMinute) * 60_000;
    const msForTokens =
      this.tokenBudget >= estimatedTokens
        ? 0
        : ((estimatedTokens - this.tokenBudget) / this.tokensPerMinute) * 60_000;
    return Math.max(msForRequest, msForTokens);
  }

  /**
   * Resolves once a request slot and `estimatedTokens` of budget are free,
   * and consumes them.
   *
   * A demand larger than the entire per-minute budget is clamped to the
   * budget: it waits for a full bucket, then consumes all of it. **Waiting
   * cannot satisfy it otherwise** — `refill()` caps `tokenBudget` at
   * `tokenCapacity`, so `tokenBudget >= estimatedTokens` never becomes true
   * and the loop below spins forever, silently. That is not theoretical: on
   * 2026-08-29 the weekly FOOTAGE REFRESH job deadlocked here. Its browser
   * agent (`browser-agent-core.ts`, since deleted — that job is entirely
   * deterministic now and makes no model calls at all) accumulated page
   * snapshots and link lists into its prompt, crossed ~20k characters —
   * `(6000 - 1024) * 4`,
   * the exact point where `estimatePromptTokens` in groq.ts tips past this
   * limiter's 6000/min capacity — and the job then sat with an idle
   * Chromium open, emitting nothing at all, until the 30-minute GitHub
   * Actions timeout killed it. Every weekly run had failed this way.
   *
   * Clamping is the honest behavior for a local pacing primitive: a bucket
   * cannot know a provider's real per-request ceiling, so it should throttle
   * hard and let Groq's own 429/413 be authoritative, never hang the caller
   * waiting for a condition it has already made unreachable.
   */
  async acquire(estimatedTokens: number): Promise<void> {
    const requested = Number.isFinite(estimatedTokens) ? Math.max(0, estimatedTokens) : 0;
    const demand = Math.min(requested, this.tokenCapacity);
    const run = async () => {
      let waitMs = this.msUntilAvailable(demand);
      while (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        waitMs = this.msUntilAvailable(demand);
      }
      this.requestTokens -= 1;
      this.tokenBudget -= demand;
    };
    const next = this.tail.then(run, run);
    /* v8 ignore next 4 -- run() never rejects; this only guards this.tail against ever
       latching a rejection if that assumption is ever broken by a future change */
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}
