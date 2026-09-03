import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "./client.ts";
import { applyMigrations } from "./apply-migrations.ts";
import { signals, sources } from "./schema.ts";
import { claimNextRunPick, listQueuedPicks, queueRunPlan, releaseStrandedPicks } from "./run-picks.ts";

describe("picks stranded by a killed render", () => {
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

  it("requeues a pick whose run is no longer alive", async () => {
    // The failure this closes: a render killed mid-download left its pick
    // claimed forever, so the next run found an empty queue and made a
    // video about something the operator had not chosen.
    await claimedBy("dead-trace", "sig1");

    expect(await releaseStrandedPicks(ctx.db, [])).toBe(1);
    const queued = await listQueuedPicks(ctx.db);
    expect(queued).toHaveLength(1);
    expect(queued[0].claimedTraceId).toBeNull();
  });

  it("leaves a pick alone while its render is still running", async () => {
    await claimedBy("live-trace", "sig1");
    expect(await releaseStrandedPicks(ctx.db, ["live-trace"])).toBe(0);
    expect(await listQueuedPicks(ctx.db)).toHaveLength(0);
  });

  it("does not requeue a pick whose story has already been written", async () => {
    // Requeueing this would make a second video about the same thing.
    await claimedBy("dead-trace", "sig1");
    await ctx.db.update(signals).set({ state: "scripted" }).where(eq(signals.id, "sig1")).run();

    expect(await releaseStrandedPicks(ctx.db, [])).toBe(0);
    expect(await listQueuedPicks(ctx.db)).toHaveLength(0);
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
