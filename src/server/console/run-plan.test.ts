import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../../db/client.ts";
import { applyMigrations } from "../../../db/apply-migrations.ts";
import { runPicks, signals, sources } from "../../../db/schema.ts";
import { claimNextRunPick, listQueuedPicks } from "../../../db/run-picks.ts";
import { cancelPlanPick, listPlan, queuePlan, queuedSignalIds } from "./run-plan.ts";

describe("the run plan", () => {
  let ctx: ReturnType<typeof createTestDb>;

  async function seedSignals(rows: { id: string; state?: "observed" | "scored" | "scripted" }[]): Promise<void> {
    await ctx.db.insert(sources).values({ id: "src1", kind: "reddit", url: "http://x" }).run();
    await ctx.db
      .insert(signals)
      .values(
        rows.map((row) => ({
          id: row.id,
          sourceId: "src1",
          canonicalUrl: `http://x/${row.id}`,
          title: `Headline ${row.id}`,
          observedAt: "2026-08-31T00:00:00.000Z",
          engagementScore: 1,
          simhash: row.id,
          state: row.state ?? ("scored" as const),
        })),
      )
      .run();
  }

  beforeEach(() => {
    ctx = createTestDb();
    applyMigrations(ctx.client);
  });

  it("queues a plan's picks in the order they were chosen", async () => {
    await seedSignals([{ id: "a" }, { id: "b" }]);

    const result = await queuePlan(ctx.db, ctx.client, { picks: [{ topic: "politics", signalId: "b" }, { topic: "ai", signalId: "a" }] });

    expect(result).toMatchObject({ kind: "ok", queued: 2 });
    const queued = await listQueuedPicks(ctx.db);
    expect(queued.map((pick) => pick.signalId)).toEqual(["b", "a"]);
    expect(queued.map((pick) => pick.topic)).toEqual(["politics", "ai"]);
  });

  it("rejects an unknown topic", async () => {
    await seedSignals([{ id: "a" }]);

    const result = await queuePlan(ctx.db, ctx.client, { picks: [{ topic: "sports", signalId: "a" }] });

    expect(result.kind).toBe("invalid");
  });

  it("rejects a plan naming a signal that does not exist", async () => {
    await seedSignals([{ id: "a" }]);

    const result = await queuePlan(ctx.db, ctx.client, { picks: [{ topic: "ai", signalId: "ghost" }] });

    expect(result).toMatchObject({ kind: "unknown_signal", signalIds: ["ghost"] });
  });

  it("refuses a story that has already been written about", async () => {
    await seedSignals([{ id: "used", state: "scripted" }]);

    const result = await queuePlan(ctx.db, ctx.client, { picks: [{ topic: "ai", signalId: "used" }] });

    expect(result).toMatchObject({ kind: "not_eligible", signalIds: ["used"] });
  });

  it("refuses the same idea twice in one plan", async () => {
    await seedSignals([{ id: "a" }]);

    const result = await queuePlan(ctx.db, ctx.client, {
      picks: [
        { topic: "ai", signalId: "a" },
        { topic: "tech", signalId: "a" },
      ],
    });

    expect(result.kind).toBe("invalid");
  });

  it("refuses an empty plan and one over the per-plan ceiling", async () => {
    await seedSignals(Array.from({ length: 7 }, (_, i) => ({ id: `s${i}` })));

    expect((await queuePlan(ctx.db, ctx.client, { picks: [] })).kind).toBe("invalid");
    expect((await queuePlan(ctx.db, ctx.client, { picks: Array.from({ length: 7 }, (_, i) => ({ topic: "ai", signalId: `s${i}` })) })).kind).toBe("invalid");
  });

  it("writes nothing at all when validation fails", async () => {
    await seedSignals([{ id: "a" }, { id: "used", state: "scripted" }]);

    await queuePlan(ctx.db, ctx.client, {
      picks: [
        { topic: "ai", signalId: "a" },
        { topic: "tech", signalId: "used" },
      ],
    });

    expect(await listQueuedPicks(ctx.db)).toEqual([]);
  });

  it("lists queued picks with the headline behind each one", async () => {
    await seedSignals([{ id: "a" }]);
    await queuePlan(ctx.db, ctx.client, { picks: [{ topic: "philosophy", signalId: "a" }] });

    const plan = await listPlan(ctx.db);

    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ topic: "philosophy", signalId: "a", title: "Headline a" });
  });

  it("hides an already-queued signal from the next ideas request", async () => {
    await seedSignals([{ id: "a" }, { id: "b" }]);
    await queuePlan(ctx.db, ctx.client, { picks: [{ topic: "ai", signalId: "a" }] });

    expect(await queuedSignalIds(ctx.db)).toEqual(["a"]);
  });

  describe("claiming", () => {
    it("claims the oldest queued pick and stamps it with the run's trace", async () => {
      await seedSignals([{ id: "a" }, { id: "b" }]);
      await queuePlan(ctx.db, ctx.client, { picks: [{ topic: "ai", signalId: "a" }, { topic: "tech", signalId: "b" }] });

      const claimed = await claimNextRunPick(ctx.db, "trace-1", "2026-08-31T11:00:00.000Z");

      expect(claimed?.signalId).toBe("a");
      expect(claimed?.claimedTraceId).toBe("trace-1");
      expect((await listQueuedPicks(ctx.db)).map((pick) => pick.signalId)).toEqual(["b"]);
    });

    it("never hands the same pick to two runs", async () => {
      await seedSignals([{ id: "a" }]);
      await queuePlan(ctx.db, ctx.client, { picks: [{ topic: "ai", signalId: "a" }] });

      const first = await claimNextRunPick(ctx.db, "trace-1", "2026-08-31T11:00:00.000Z");
      const second = await claimNextRunPick(ctx.db, "trace-2", "2026-08-31T11:00:01.000Z");

      expect(first?.signalId).toBe("a");
      expect(second).toBeNull();
    });

    it("will not claim a pick whose signal has since been scripted", async () => {
      await seedSignals([{ id: "a" }]);
      await queuePlan(ctx.db, ctx.client, { picks: [{ topic: "ai", signalId: "a" }] });
      await ctx.db.update(signals).set({ state: "scripted" }).run();

      expect(await claimNextRunPick(ctx.db, "trace-1", "2026-08-31T11:00:00.000Z")).toBeNull();
    });

    it("returns null on an empty queue, so a scheduled render just picks for itself", async () => {
      expect(await claimNextRunPick(ctx.db, "trace-1", "2026-08-31T11:00:00.000Z")).toBeNull();
    });
  });

  describe("cancelling", () => {
    it("cancels a queued pick", async () => {
      await seedSignals([{ id: "a" }]);
      await queuePlan(ctx.db, ctx.client, { picks: [{ topic: "ai", signalId: "a" }] });
      const [pick] = await listQueuedPicks(ctx.db);

      expect(await cancelPlanPick(ctx.db, pick.id)).toEqual({ kind: "ok" });
      expect(await listQueuedPicks(ctx.db)).toEqual([]);
    });

    it("refuses to cancel a pick a run has already claimed", async () => {
      await seedSignals([{ id: "a" }]);
      await queuePlan(ctx.db, ctx.client, { picks: [{ topic: "ai", signalId: "a" }] });
      const [pick] = await listQueuedPicks(ctx.db);
      await claimNextRunPick(ctx.db, "trace-1", "2026-08-31T11:00:00.000Z");

      expect(await cancelPlanPick(ctx.db, pick.id)).toEqual({ kind: "not_found" });
      const rows = await ctx.db.select().from(runPicks).all();
      expect(rows[0].status).toBe("claimed");
    });

    it("reports an unknown pick id as not found", async () => {
      expect(await cancelPlanPick(ctx.db, "ghost")).toEqual({ kind: "not_found" });
    });
  });
});
