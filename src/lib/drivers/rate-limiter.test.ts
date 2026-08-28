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
