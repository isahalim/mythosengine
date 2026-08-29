import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenBucketLimiter } from "./rate-limiter.ts";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TokenBucketLimiter", () => {
  it("allows immediate acquisition within budget", async () => {
    const limiter = new TokenBucketLimiter(30, 6000);
    await expect(limiter.acquire(1000)).resolves.toBeUndefined();
  });

  it("blocks a request that exceeds the per-minute request cap until refill", async () => {
    const limiter = new TokenBucketLimiter(1, 6000);
    await limiter.acquire(10); // consumes the single request token

    let resolved = false;
    const second = limiter.acquire(10).then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(resolved).toBe(false); // half the refill window: still not a full token

    await vi.advanceTimersByTimeAsync(31_000);
    await second;
    expect(resolved).toBe(true);
  });

  it("serializes concurrent callers instead of letting them interleave", async () => {
    const limiter = new TokenBucketLimiter(60, 60_000);
    const order: number[] = [];

    const calls = [1, 2, 3].map((id) =>
      limiter.acquire(1000).then(() => {
        order.push(id);
      }),
    );

    await vi.runAllTimersAsync();
    await Promise.all(calls);

    expect(order).toEqual([1, 2, 3]);
  });

  // Regression: the 2026-08-29 FOOTAGE REFRESH deadlock. A demand larger
  // than the whole per-minute budget used to wait for a condition refill()
  // caps out of reach, so acquire() never resolved — the weekly job sat
  // silent with an idle Chromium until the 30-minute Actions timeout.
  it("never hangs on a demand larger than the entire per-minute budget", async () => {
    const limiter = new TokenBucketLimiter(30, 6000);

    let resolved = false;
    const oversized = limiter.acquire(7024).then(() => {
      resolved = true;
    });

    await vi.runAllTimersAsync();
    await oversized;
    expect(resolved).toBe(true);
  });

  it("charges an oversized demand the full bucket, so the next call still waits its turn", async () => {
    const limiter = new TokenBucketLimiter(30, 6000);
    await limiter.acquire(50_000); // clamped to 6000 — drains the bucket entirely

    let resolved = false;
    const next = limiter.acquire(3000).then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(29_000);
    expect(resolved).toBe(false); // budget refills at 6000/min: 3000 needs 30s

    await vi.advanceTimersByTimeAsync(2_000);
    await next;
    expect(resolved).toBe(true);
  });

  it("treats a non-finite or negative demand as zero rather than poisoning the budget", async () => {
    const limiter = new TokenBucketLimiter(30, 6000);
    await expect(limiter.acquire(Number.NaN)).resolves.toBeUndefined();
    await expect(limiter.acquire(-1000)).resolves.toBeUndefined();
    // A negative demand must not have *credited* the bucket above capacity.
    await limiter.acquire(6000);
    let resolved = false;
    void limiter.acquire(6000).then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(resolved).toBe(false);
  });

  it("blocks on token budget even when request slots are free", async () => {
    const limiter = new TokenBucketLimiter(30, 100);
    await limiter.acquire(90); // leaves 10 tokens

    let resolved = false;
    const second = limiter.acquire(50).then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(30_000);
    await second;
    expect(resolved).toBe(true);
  });
});
