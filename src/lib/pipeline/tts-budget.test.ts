import { describe, expect, it } from "vitest";
import { geminiQuotaDay, readGeminiTtsBudget, recordGeminiTtsAttempt, settleGeminiTtsAttempt } from "./tts-budget.ts";
import type { KvLike } from "../drivers/cache-kv.ts";
import { QUOTAS } from "../../config/quotas.ts";

class FakeKv implements KvLike {
  store = new Map<string, string>();
  ttls: number[] = [];
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, value);
    if (options?.expirationTtl !== undefined) this.ttls.push(options.expirationTtl);
  }
}

/** The 429 body Gemini actually returned on 2026-09-02, trimmed to the part this code reads. */
const DAILY_QUOTA_429 =
  "rate_limited: HTTP 429 from https://generativelanguage.googleapis.com/v1beta/interactions: " +
  '{"error":{"message":"You exceeded your current quota... Quota exceeded for metric: ' +
  'generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10, model: gemini-3.1-flash-tts"}}';

describe("geminiQuotaDay", () => {
  it("keys on the Pacific day, not the UTC one — which is the whole bug", () => {
    // 2026-09-02T05:00Z is 22:00 on 2026-09-01 in Los Angeles. The UTC day
    // has already rolled over; Gemini's quota day has not, and counting the
    // UTC one is what let a render believe it had spent nothing while all
    // ten of the day's requests were gone.
    expect(geminiQuotaDay(new Date("2026-09-02T05:00:00.000Z"))).toBe("2026-09-01");
    expect(new Date("2026-09-02T05:00:00.000Z").toISOString().slice(0, 10)).toBe("2026-09-02");
  });

  it("rolls over at midnight Pacific", () => {
    // 07:00Z is midnight PDT.
    expect(geminiQuotaDay(new Date("2026-09-02T06:59:00.000Z"))).toBe("2026-09-01");
    expect(geminiQuotaDay(new Date("2026-09-02T07:01:00.000Z"))).toBe("2026-09-02");
  });

  it("stays correct across the standard-time offset, where a hand-rolled -7h would not", () => {
    // 2026-01-15T07:30Z is 23:30 on the 14th in PST (UTC-8).
    expect(geminiQuotaDay(new Date("2026-01-15T07:30:00.000Z"))).toBe("2026-01-14");
  });
});

describe("readGeminiTtsBudget", () => {
  const now = new Date("2026-09-02T05:00:00.000Z");

  it("reports nothing spent when no ledger exists yet", async () => {
    const budget = await readGeminiTtsBudget(new FakeKv(), now);
    expect(budget).toEqual({ day: "2026-09-01", spent: 0, budget: QUOTAS.gemini.ttsRequestsPerDayBudget, readable: true });
  });

  it("counts every recorded attempt, including the ones that failed", async () => {
    const kv = new FakeKv();
    await recordGeminiTtsAttempt(kv, "trace-1", now);
    await settleGeminiTtsAttempt(kv, "failed", "network: socket hang up", now);
    await recordGeminiTtsAttempt(kv, "trace-2", now);
    await settleGeminiTtsAttempt(kv, "succeeded", null, now);

    // Two requests were sent. One render came out on Gemini. Counting
    // renders would have said one.
    expect((await readGeminiTtsBudget(kv, now)).spent).toBe(2);
  });

  it("treats an unreadable ledger as fully spent, never as a fresh day", async () => {
    const kv = new FakeKv();
    await kv.put("gemini-tts-ledger:2026-09-01", "{not json");
    const budget = await readGeminiTtsBudget(kv, now);
    expect(budget.readable).toBe(false);
    expect(budget.spent).toBe(budget.budget);
  });

  it("keys separately per Pacific day, so yesterday's spend does not follow today", async () => {
    const kv = new FakeKv();
    await recordGeminiTtsAttempt(kv, "trace-1", now);
    expect((await readGeminiTtsBudget(kv, new Date("2026-09-02T08:00:00.000Z"))).spent).toBe(0);
  });
});

describe("recordGeminiTtsAttempt", () => {
  const now = new Date("2026-09-02T05:00:00.000Z");

  it("counts the request before it is sent, so a crash mid-synthesis is still counted", async () => {
    const kv = new FakeKv();
    await recordGeminiTtsAttempt(kv, "trace-1", now);
    // Nothing settles it — the process died. The request still happened.
    expect((await readGeminiTtsBudget(kv, now)).spent).toBe(1);
  });

  it("gives the ledger a TTL so it cannot outlive the day it describes", async () => {
    const kv = new FakeKv();
    await recordGeminiTtsAttempt(kv, "trace-1", now);
    expect(kv.ttls).toEqual([2 * 86_400]);
  });
});

describe("settleGeminiTtsAttempt", () => {
  const now = new Date("2026-09-02T05:00:00.000Z");

  it("writes off the rest of the day when Gemini says the daily quota is gone", async () => {
    const kv = new FakeKv();
    await recordGeminiTtsAttempt(kv, "trace-1", now);
    await settleGeminiTtsAttempt(kv, "failed", DAILY_QUOTA_429, now);

    const budget = await readGeminiTtsBudget(kv, now);
    expect(budget.spent).toBe(budget.budget);
  });

  it("leaves the budget alone for a failure that is not the daily quota", async () => {
    const kv = new FakeKv();
    await recordGeminiTtsAttempt(kv, "trace-1", now);
    await settleGeminiTtsAttempt(kv, "failed", "timeout: the request took too long", now);
    expect((await readGeminiTtsBudget(kv, now)).spent).toBe(1);
  });

  it("is a no-op when there is nothing to settle", async () => {
    const kv = new FakeKv();
    await settleGeminiTtsAttempt(kv, "succeeded", null, now);
    expect((await readGeminiTtsBudget(kv, now)).spent).toBe(0);
  });

  it("does not resurrect an unreadable ledger", async () => {
    const kv = new FakeKv();
    await kv.put("gemini-tts-ledger:2026-09-01", "[]");
    await settleGeminiTtsAttempt(kv, "succeeded", null, now);
    expect((await readGeminiTtsBudget(kv, now)).readable).toBe(false);
  });
});
