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

  /** Resolves once a request slot and `estimatedTokens` of budget are free, and consumes them. */
  async acquire(estimatedTokens: number): Promise<void> {
    const run = async () => {
      let waitMs = this.msUntilAvailable(estimatedTokens);
      while (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        waitMs = this.msUntilAvailable(estimatedTokens);
      }
      this.requestTokens -= 1;
      this.tokenBudget -= estimatedTokens;
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
