import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "./client.ts";
import { applyMigrations } from "./apply-migrations.ts";
import { runPicks, signals, sources } from "./schema.ts";
import { claimNextRunPick, listQueuedPicks, queueRunPlan, retireStrandedPicks } from "./run-picks.ts";

describe("picks stranded by a render that failed or was killed", () => {
  let ctx: ReturnType<typeof createTestDb>;

  beforeEach(async () => {
    ctx = createTestDb();
    applyMigrations(ctx.client);
    await ctx.db.insert(sources).values({ id: "src1", kind: "reddit", url: "http://x" }).run();
    for (const id of ["sig1", "sig2"]) {
      await ctx.db
        .insert(signals)
        .values({ id, sourceId: "src1", canonicalUrl: `http://x/${id}`, title: id, observedAt: "2026-01-01", engagementScore: 1, simhash: id, state: "scored" })
        .run();
    }
  });

  async function claimedBy(traceId: string, signalId: string): Promise<void> {
    await queueRunPlan(ctx.client, [{ topic: "viral", signalId }]);
    await claimNextRunPick(ctx.db, traceId, "2026-09-01T00:00:00.000Z");
  }

  it("cancels a pick whose run is no longer alive, rather than putting it back on the queue", async () => {
    // Operator direction 2026-09-03: a failed run is reported as failed and
    // its pick leaves the queue. Requeueing is what let a story chosen in an
    // earlier session take a later run's only slot, and its tokens.
    await claimedBy("dead-trace", "sig1");

    expect(await retireStrandedPicks(ctx.db, [])).toBe(1);
    expect(await listQueuedPicks(ctx.db)).toHaveLength(0);
    const rows = await ctx.db.select().from(runPicks).all();
    expect(rows.map((row) => row.status)).toEqual(["cancelled"]);
  });

  it("leaves a pick alone while its render is still running", async () => {
    await claimedBy("live-trace", "sig1");
    expect(await retireStrandedPicks(ctx.db, ["live-trace"])).toBe(0);
    const rows = await ctx.db.select().from(runPicks).all();
    expect(rows.map((row) => row.status)).toEqual(["claimed"]);
  });

  it("does not touch a pick whose story was actually written", async () => {
    // Whatever failed afterwards, this story was made; recording it as
    // cancelled would be false.
    await claimedBy("dead-trace", "sig1");
    await ctx.db.update(signals).set({ state: "scripted" }).where(eq(signals.id, "sig1")).run();

    expect(await retireStrandedPicks(ctx.db, [])).toBe(0);
    const rows = await ctx.db.select().from(runPicks).all();
    expect(rows.map((row) => row.status)).toEqual(["claimed"]);
  });
});

describe("claim order", () => {
  let ctx: ReturnType<typeof createTestDb>;

  beforeEach(async () => {
    ctx = createTestDb();
    applyMigrations(ctx.client);
    await ctx.db.insert(sources).values({ id: "src1", kind: "reddit", url: "http://x" }).run();
    for (const id of ["stale", "fresh-a", "fresh-b"]) {
      await ctx.db
        .insert(signals)
        .values({ id, sourceId: "src1", canonicalUrl: `http://x/${id}`, title: id, observedAt: "2026-01-01", engagementScore: 1, simhash: id, state: "scored" })
        .run();
    }
  });

  it("renders the story the operator just picked, not a leftover requeued from this morning", async () => {
    // 2026-09-03 verbatim: a pick from 07:02 whose render failed at SCRIPT
    // was swept back onto the queue by the invocation's own startup, after
    // the dispatch had already sized the run to the one story the operator
    // chose at 20:14 — so FIFO made the leftover and the fresh pick was
    // never made at all.
    await queueRunPlan(ctx.client, [{ topic: "politics", signalId: "stale" }], () => Date.parse("2026-09-03T07:02:30.489Z"));
    await queueRunPlan(ctx.client, [{ topic: "tech", signalId: "fresh-a" }], () => Date.parse("2026-09-03T20:14:44.438Z"));

    const claimed = await claimNextRunPick(ctx.db, "trace-1", "2026-09-03T20:15:00.000Z");

    expect(claimed?.signalId).toBe("fresh-a");
    // The leftover is not dropped — it is next in line for whichever
    // invocation finds nothing newer.
    expect((await listQueuedPicks(ctx.db)).map((pick) => pick.signalId)).toEqual(["stale"]);
  });

  it("claims only from the plan the dispatch named, never an older one", async () => {
    // The whole point of the scope (operator direction 2026-09-03): no key
    // is spent on a story chosen in an earlier session.
    const stalePlan = await queueRunPlan(ctx.client, [{ topic: "politics", signalId: "stale" }], () => Date.parse("2026-09-03T07:02:30.489Z"));
    const freshPlan = await queueRunPlan(ctx.client, [{ topic: "tech", signalId: "fresh-a" }], () => Date.parse("2026-09-03T20:14:44.438Z"));

    expect((await claimNextRunPick(ctx.db, "trace-1", "2026-09-03T20:15:00.000Z", freshPlan))?.signalId).toBe("fresh-a");
    // And once that plan is empty there is nothing to claim — the older
    // plan's pick is not a fallback, it is a different video.
    expect(await claimNextRunPick(ctx.db, "trace-1", "2026-09-03T20:40:00.000Z", freshPlan)).toBeNull();
    expect((await listQueuedPicks(ctx.db)).map((pick) => pick.planId)).toEqual([stalePlan]);
  });

  it("keeps a scoped run inside its plan even when a newer plan is queued mid-run", async () => {
    const runningPlan = await queueRunPlan(
      ctx.client,
      [
        { topic: "tech", signalId: "fresh-a" },
        { topic: "tech", signalId: "fresh-b" },
      ],
      () => Date.parse("2026-09-03T20:14:44.438Z"),
    );
    await claimNextRunPick(ctx.db, "trace-1", "2026-09-03T20:15:00.000Z", runningPlan);
    await queueRunPlan(ctx.client, [{ topic: "politics", signalId: "stale" }], () => Date.parse("2026-09-03T20:30:00.000Z"));

    // The second invocation of the run already in flight still makes the
    // video the operator asked it for, not the one queued since.
    expect((await claimNextRunPick(ctx.db, "trace-1", "2026-09-03T20:31:00.000Z", runningPlan))?.signalId).toBe("fresh-b");
  });

  it("keeps one plan's own picks in the order the operator built them", async () => {
    await queueRunPlan(
      ctx.client,
      [
        { topic: "tech", signalId: "fresh-a" },
        { topic: "tech", signalId: "fresh-b" },
      ],
      () => Date.parse("2026-09-03T20:14:44.438Z"),
    );

    expect((await claimNextRunPick(ctx.db, "trace-1", "2026-09-03T20:15:00.000Z"))?.signalId).toBe("fresh-a");
    expect((await claimNextRunPick(ctx.db, "trace-2", "2026-09-03T20:16:00.000Z"))?.signalId).toBe("fresh-b");
  });
});
