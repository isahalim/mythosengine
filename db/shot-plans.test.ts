import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "./client.ts";
import { applyMigrations } from "./apply-migrations.ts";
import { scripts, signals, sources } from "./schema.ts";
import { advanceShot, reapAbandonedShots, saveShotPlan, shotsForScripts, shotsForTrace } from "./shot-plans.ts";

const NOW = "2026-09-01T12:00:00.000Z";
const LATER = "2026-09-01T13:00:00.000Z";

async function seedScript(ctx: ReturnType<typeof createTestDb>, id: string, traceId: string): Promise<void> {
  await ctx.db.insert(scripts).values({ id, signalId: "sig1", hook: "h", body: "b", debateQuestion: "q", wordCount: 5, status: "draft", traceId, createdAt: NOW }).run();
}

describe("shot plans", () => {
  let ctx: ReturnType<typeof createTestDb>;

  beforeEach(async () => {
    ctx = createTestDb();
    applyMigrations(ctx.client);
    await ctx.db.insert(sources).values({ id: "src1", kind: "reddit", url: "http://x" }).run();
    await ctx.db
      .insert(signals)
      .values({ id: "sig1", sourceId: "src1", canonicalUrl: "http://x/1", title: "t", observedAt: NOW, engagementScore: 1, simhash: "a", state: "scored" })
      .run();
  });

  it("saves a whole plan and reads it back in plan order", async () => {
    await seedScript(ctx, "scr1", "trace1");
    await saveShotPlan(
      ctx.client,
      "scr1",
      "trace1",
      [
        { position: 0, beatIndex: null, intent: "opening", query: "city street crowd", source: "pexels" },
        { position: 1, beatIndex: 0, intent: "the real thing", query: "GTA 6 walkthrough gameplay", source: "youtube" },
      ],
      NOW,
    );

    const rows = await shotsForTrace(ctx.db, "trace1");
    expect(rows.map((r) => r.position)).toEqual([0, 1]);
    expect(rows.every((r) => r.status === "planned")).toBe(true);
    expect(rows[1].source).toBe("youtube");
  });

  it("advances exactly one shot, not every shot of the script", async () => {
    await seedScript(ctx, "scr1", "trace1");
    await saveShotPlan(
      ctx.client,
      "scr1",
      "trace1",
      [
        { position: 0, beatIndex: null, intent: "a", query: "one query", source: "pexels" },
        { position: 1, beatIndex: 0, intent: "b", query: "two query", source: "pexels" },
      ],
      NOW,
    );

    await advanceShot(ctx.db, "scr1", 1, "clipped", LATER, { footageSegmentId: "seg9" });

    const rows = await shotsForScripts(ctx.db, ["scr1"]);
    expect(rows[0].status).toBe("planned");
    expect(rows[1].status).toBe("clipped");
    expect(rows[1].footageSegmentId).toBe("seg9");
  });

  it("clears a stale error when a shot moves on", async () => {
    // A shot that failed one candidate and succeeded on the next must not
    // keep displaying the reason it nearly did not.
    await seedScript(ctx, "scr1", "trace1");
    await saveShotPlan(ctx.client, "scr1", "trace1", [{ position: 0, beatIndex: null, intent: "a", query: "one query", source: "pexels" }], NOW);

    await advanceShot(ctx.db, "scr1", 0, "failed", LATER, { error: "first candidate was not a video" });
    await advanceShot(ctx.db, "scr1", 0, "clipped", LATER, { footageSegmentId: "seg1" });

    const rows = await shotsForScripts(ctx.db, ["scr1"]);
    expect(rows[0].error).toBeNull();
  });

  it("marks shots abandoned when their render is no longer running", async () => {
    // The failure this closes: a render killed mid-download left its rows at
    // `downloading`, and stage 5 showed a shot as in-flight for a run that
    // stopped hours ago.
    await seedScript(ctx, "dead", "dead-trace");
    await seedScript(ctx, "live", "live-trace");
    await saveShotPlan(ctx.client, "dead", "dead-trace", [{ position: 0, beatIndex: null, intent: "a", query: "one query", source: "youtube" }], NOW);
    await saveShotPlan(ctx.client, "live", "live-trace", [{ position: 0, beatIndex: null, intent: "b", query: "two query", source: "youtube" }], NOW);
    await advanceShot(ctx.db, "dead", 0, "downloading", NOW);
    await advanceShot(ctx.db, "live", 0, "downloading", NOW);

    expect(await reapAbandonedShots(ctx.db, ["live-trace"], LATER)).toBe(1);

    const dead = await shotsForScripts(ctx.db, ["dead"]);
    const live = await shotsForScripts(ctx.db, ["live"]);
    expect(dead[0].status).toBe("failed");
    expect(dead[0].error).toContain("abandoned");
    expect(live[0].status).toBe("downloading");
  });

  it("leaves a shot that actually made it into a video alone", async () => {
    await seedScript(ctx, "scr1", "old-trace");
    await saveShotPlan(ctx.client, "scr1", "old-trace", [{ position: 0, beatIndex: null, intent: "a", query: "one query", source: "pexels" }], NOW);
    await advanceShot(ctx.db, "scr1", 0, "composited", NOW, { footageSegmentId: "seg1" });

    expect(await reapAbandonedShots(ctx.db, [], LATER)).toBe(0);
    expect((await shotsForScripts(ctx.db, ["scr1"]))[0].status).toBe("composited");
  });

  it("treats `clipped` as unfinished, because the clip never reached a video", async () => {
    await seedScript(ctx, "scr1", "dead-trace");
    await saveShotPlan(ctx.client, "scr1", "dead-trace", [{ position: 0, beatIndex: null, intent: "a", query: "one query", source: "pexels" }], NOW);
    await advanceShot(ctx.db, "scr1", 0, "clipped", NOW, { footageSegmentId: "seg1" });

    expect(await reapAbandonedShots(ctx.db, [], LATER)).toBe(1);
  });
});
