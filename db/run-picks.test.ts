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
