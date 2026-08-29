import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../../../db/apply-migrations.ts";
import { createTestDb } from "../../../db/client.ts";
import { signals, sources } from "../../../db/schema.ts";
import { simhash64, simhashToHex } from "./simhash.ts";
import { scoreObservedSignals } from "./score.ts";

describe("scoreObservedSignals", () => {
  let ctx: ReturnType<typeof createTestDb>;
  const now = new Date("2026-08-28T12:00:00Z");

  beforeEach(() => {
    ctx = createTestDb();
    applyMigrations(ctx.client);
    ctx.db.insert(sources).values({ id: "src1", kind: "rss", url: "https://example.com" }).run();
  });

  afterEach(() => {
    ctx.client.close();
  });

  function insertSignal(overrides: Partial<typeof signals.$inferInsert> & { id: string; title: string }) {
    ctx.db
      .insert(signals)
      .values({
        sourceId: "src1",
        canonicalUrl: `https://example.com/${overrides.id}`,
        observedAt: now.toISOString(),
        engagementScore: 1,
        simhash: simhashToHex(simhash64(overrides.title)),
        state: "observed",
        ...overrides,
      })
      .run();
  }

  function stateOf(id: string): string {
    return ctx.db.select().from(signals).where(eq(signals.id, id)).get()?.state ?? "MISSING";
  }

  it("promotes distinct signals with no near-duplicates to scored", async () => {
    insertSignal({ id: "a", title: "Apple unveils new iPhone at fall event" });
    insertSignal({ id: "b", title: "City council approves new bike lane funding downtown" });

    const result = await scoreObservedSignals(ctx.db, now);
    expect(result).toEqual({ scored: 2, rejectedAsDuplicate: 0, rejectedAsFuture: 0 });
    expect(stateOf("a")).toBe("scored");
    expect(stateOf("b")).toBe("scored");
  });

  it("collapses a 3-way near-duplicate cluster to exactly one scored survivor", async () => {
    insertSignal({ id: "a", title: "GTA 6 trailer breaks YouTube view count record", engagementScore: 0.5 });
    insertSignal({ id: "b", title: "GTA 6 trailer breaks the YouTube view count record", engagementScore: 0.9 });
    insertSignal({ id: "c", title: "GTA 6 trailer breaks YouTube view count records", engagementScore: 0.3 });

    const result = await scoreObservedSignals(ctx.db, now);
    expect(result.scored).toBe(1);
    expect(result.rejectedAsDuplicate).toBe(2);

    const states = ["a", "b", "c"].map(stateOf);
    expect(states.filter((s) => s === "scored")).toHaveLength(1);
    expect(states.filter((s) => s === "rejected")).toHaveLength(2);
    // the highest-engagementScore member of the cluster is the one that survives
    expect(stateOf("b")).toBe("scored");
  });

  it("applies a corroboration bonus proportional to cluster size", async () => {
    insertSignal({ id: "a", title: "GTA 6 trailer breaks YouTube view count record", engagementScore: 0.5 });
    insertSignal({ id: "b", title: "GTA 6 trailer breaks the YouTube view count record", engagementScore: 0.5 });
    insertSignal({ id: "c", title: "GTA 6 trailer breaks YouTube view count records", engagementScore: 0.5 });
    insertSignal({ id: "solo", title: "Unrelated story about municipal budgets" });

    await scoreObservedSignals(ctx.db, now);

    const winner = ctx.db.select().from(signals).where(eq(signals.state, "scored")).all().find((s) => s.id !== "solo");
    const solo = ctx.db.select().from(signals).where(eq(signals.id, "solo")).get();
    expect(winner?.engagementScore).toBeGreaterThan(0.5);
    expect(solo?.engagementScore).toBe(1); // no corroboration, no bonus
  });

  it("rejects a future-dated signal outright, even with the highest engagementScore", async () => {
    insertSignal({
      id: "future",
      title: "Some story from the future",
      observedAt: new Date(now.getTime() + 60_000).toISOString(),
      engagementScore: 999,
    });
    insertSignal({ id: "real", title: "An entirely unrelated real story" });

    const result = await scoreObservedSignals(ctx.db, now);
    expect(result.rejectedAsFuture).toBe(1);
    expect(stateOf("future")).toBe("rejected");
    expect(stateOf("real")).toBe("scored");
  });

  it("a future-dated signal never wins its cluster over a valid duplicate", async () => {
    insertSignal({
      id: "future",
      title: "GTA 6 trailer breaks YouTube view count record",
      observedAt: new Date(now.getTime() + 60_000).toISOString(),
      engagementScore: 999,
    });
    insertSignal({ id: "valid", title: "GTA 6 trailer breaks the YouTube view count record", engagementScore: 0.4 });

    const result = await scoreObservedSignals(ctx.db, now);
    expect(stateOf("future")).toBe("rejected");
    expect(stateOf("valid")).toBe("scored");
    expect(result.scored).toBe(1);
  });

  it("counts corroboration against already-scored signals from earlier runs in the trailing window", async () => {
    insertSignal({ id: "earlier", title: "GTA 6 trailer breaks YouTube view count record" });
    await scoreObservedSignals(ctx.db, now); // promotes "earlier" to scored

    insertSignal({ id: "later", title: "GTA 6 trailer breaks the YouTube view count record", engagementScore: 1 });
    await scoreObservedSignals(ctx.db, now);

    const later = ctx.db.select().from(signals).where(eq(signals.id, "later")).get();
    expect(later?.engagementScore).toBeGreaterThan(1); // bonus from corroborating "earlier"
  });
});
