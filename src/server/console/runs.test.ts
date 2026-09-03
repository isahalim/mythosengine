import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../../db/client.ts";
import { applyMigrations } from "../../../db/apply-migrations.ts";
import { exports as exportsTable, footageSegments, footageSources, renders, runs, scripts, signals, sources } from "../../../db/schema.ts";
import { advanceShot, saveShotPlan } from "../../../db/shot-plans.ts";
import { getRunProgress, listRecentRuns } from "./runs.ts";

const TRACE = "trace-1";

async function seedSignal(ctx: ReturnType<typeof createTestDb>, id = "sig1"): Promise<void> {
  await ctx.db.insert(sources).values({ id: "src1", kind: "reddit", url: "http://x" }).run();
  await ctx.db
    .insert(signals)
    .values({ id, sourceId: "src1", canonicalUrl: `http://x/${id}`, title: "t", observedAt: "2026-08-31T00:00:00.000Z", engagementScore: 1, simhash: "a", state: "scripted" })
    .run();
}

async function seedFootage(ctx: ReturnType<typeof createTestDb>): Promise<void> {
  await ctx.db
    .insert(footageSources)
    .values({ id: "fs1", channelUrl: "https://youtube.com/@HollowPoiint", game: "GTA V", licenseNote: "walkthrough", enabled: 1 })
    .run();
  await ctx.db
    .insert(footageSegments)
    .values({
      id: "seg1",
      footageSourceId: "fs1",
      sourceVideoId: "vid1",
      clipStartS: 600,
      clipEndS: 665,
      motionScore: 0.5,
      libraryPath: "clips/seg1.mp4",
      usedCount: 0,
      fetchedAt: "2026-08-31T00:00:00.000Z",
    })
    .run();
}

describe("getRunProgress", () => {
  let ctx: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    ctx = createTestDb();
    applyMigrations(ctx.client);
  });

  it("returns null for a trace that has no run rows", async () => {
    expect(await getRunProgress(ctx.db, "nope")).toBeNull();
  });

  it("reports a dispatch-only trace as not_triggered, with the note dispatch itself returns", async () => {
    await ctx.db.insert(runs).values({ id: "r1", startedAt: "2026-08-31T10:00:00.000Z", stage: "dispatch", status: "queued", traceId: TRACE }).run();

    const progress = await getRunProgress(ctx.db, TRACE);

    expect(progress?.status).toBe("not_triggered");
    expect(progress?.note).toContain("workflow_dispatch");
    expect(progress?.videos).toEqual([]);
  });

  it("orders the stages by start time and reports a run with an open stage as running", async () => {
    await ctx.db
      .insert(runs)
      .values([
        { id: "r2", startedAt: "2026-08-31T10:00:05.000Z", finishedAt: "2026-08-31T10:00:09.000Z", stage: "script", status: "succeeded", traceId: TRACE },
        { id: "r1", startedAt: "2026-08-31T10:00:00.000Z", finishedAt: "2026-08-31T10:00:04.000Z", stage: "research", status: "succeeded", traceId: TRACE },
        { id: "r3", startedAt: "2026-08-31T10:00:10.000Z", stage: "critic", status: "running", traceId: TRACE },
      ])
      .run();

    const progress = await getRunProgress(ctx.db, TRACE);

    expect(progress?.stages.map((s) => s.stage)).toEqual(["research", "script", "critic"]);
    expect(progress?.status).toBe("running");
    expect(progress?.finishedAt).toBeNull();
  });

  it("does not call a run failed because a stage degraded, but still shows what degraded", async () => {
    // RESEARCH, PLAN, ALIGN, EDIT, HOST and CRITIC are each contractually
    // allowed to fail without costing the video. They used to close their
    // row as `failed`, so a render that degraded exactly as designed and
    // then exported a video told the operator "The run failed".
    await ctx.db
      .insert(runs)
      .values([
        { id: "r1", startedAt: "2026-08-31T10:00:00.000Z", finishedAt: "2026-08-31T10:00:04.000Z", stage: "research", status: "degraded", errorClass: "provider_error", traceId: TRACE },
        { id: "r2", startedAt: "2026-08-31T10:00:05.000Z", finishedAt: "2026-08-31T10:00:06.000Z", stage: "script", status: "succeeded", traceId: TRACE },
        { id: "r3", startedAt: "2026-08-31T10:00:07.000Z", finishedAt: "2026-08-31T10:00:08.000Z", stage: "critic", status: "degraded", errorClass: "rate_limited", traceId: TRACE },
        { id: "r4", startedAt: "2026-08-31T10:00:09.000Z", finishedAt: "2026-08-31T10:00:20.000Z", stage: "export", status: "succeeded", traceId: TRACE },
      ])
      .run();

    const progress = await getRunProgress(ctx.db, TRACE);

    expect(progress?.status).toBe("succeeded");
    expect(progress?.stages.map((s) => s.status)).toEqual(["degraded", "succeeded", "degraded", "succeeded"]);
    expect(progress?.stages[2].errorClass).toBe("rate_limited");
  });

  it("still reports a genuinely failed stage as a failed run, degraded siblings or not", async () => {
    await ctx.db
      .insert(runs)
      .values([
        { id: "r1", startedAt: "2026-08-31T10:00:00.000Z", finishedAt: "2026-08-31T10:00:04.000Z", stage: "research", status: "degraded", errorClass: "provider_error", traceId: TRACE },
        { id: "r2", startedAt: "2026-08-31T10:00:05.000Z", finishedAt: "2026-08-31T10:00:06.000Z", stage: "tts", status: "failed", errorClass: "provider_error", traceId: TRACE },
      ])
      .run();

    expect((await getRunProgress(ctx.db, TRACE))?.status).toBe("failed");
  });

  it("reports a failed stage as a failed run and keeps its error class", async () => {
    await ctx.db
      .insert(runs)
      .values([
        { id: "r1", startedAt: "2026-08-31T10:00:00.000Z", finishedAt: "2026-08-31T10:00:04.000Z", stage: "research", status: "succeeded", traceId: TRACE },
        { id: "r2", startedAt: "2026-08-31T10:00:05.000Z", finishedAt: "2026-08-31T10:00:06.000Z", stage: "script", status: "failed", errorClass: "provider_error", traceId: TRACE },
      ])
      .run();

    const progress = await getRunProgress(ctx.db, TRACE);

    expect(progress?.status).toBe("failed");
    expect(progress?.stages[1].errorClass).toBe("provider_error");
  });

  it("keeps a run running in the gap between two stages, where every row it has written is closed", async () => {
    // The 2026-09-03 freeze: EDIT closed at 20:43:09.924Z and RENDER opened
    // at 20:43:11.972Z, and in those two seconds every stage row this trace
    // had was finished. Stage 4 read that as a finished run, stopped
    // polling, and sat on `EDIT · SUCCEEDED` / `0 / 1 exported` while the
    // render went on to export.
    await ctx.db
      .insert(runs)
      .values([
        { id: "r0", startedAt: "2026-09-03T20:14:47.000Z", stage: "pipeline", status: "running", traceId: TRACE },
        { id: "r1", startedAt: "2026-09-03T20:30:35.744Z", finishedAt: "2026-09-03T20:43:09.924Z", stage: "edit", status: "succeeded", traceId: TRACE },
      ])
      .run();

    expect((await getRunProgress(ctx.db, TRACE))?.status).toBe("running");
  });

  it("reports the run as succeeded once the invocation's own row is closed", async () => {
    await ctx.db
      .insert(runs)
      .values([
        { id: "r0", startedAt: "2026-09-03T20:14:47.000Z", finishedAt: "2026-09-03T20:43:49.000Z", stage: "pipeline", status: "succeeded", traceId: TRACE },
        { id: "r1", startedAt: "2026-09-03T20:43:46.393Z", finishedAt: "2026-09-03T20:43:48.949Z", stage: "export", status: "succeeded", traceId: TRACE },
      ])
      .run();

    expect((await getRunProgress(ctx.db, TRACE))?.status).toBe("succeeded");
  });

  it("fails a run that threw between two stages, where no stage row is holding the failure", async () => {
    // `PLAN produced no shots` closes PLAN as succeeded and then throws.
    await ctx.db
      .insert(runs)
      .values([
        { id: "r0", startedAt: "2026-09-03T20:14:47.000Z", finishedAt: "2026-09-03T20:24:57.000Z", stage: "pipeline", status: "failed", errorClass: "PLAN produced no shots, so there is nothing to source.", traceId: TRACE },
        { id: "r1", startedAt: "2026-09-03T20:24:18.439Z", finishedAt: "2026-09-03T20:24:56.444Z", stage: "plan", status: "succeeded", traceId: TRACE },
      ])
      .run();

    const progress = await getRunProgress(ctx.db, TRACE);

    expect(progress?.status).toBe("failed");
    expect(progress?.stages[0].errorClass).toContain("PLAN produced no shots");
  });

  it("reports an invocation that ran and made nothing as over, not as still queued", async () => {
    // The killswitch was off, or WATCH had scored nothing: there are no
    // stage rows, and the run is finished all the same.
    await ctx.db
      .insert(runs)
      .values([
        { id: "d1", startedAt: "2026-09-03T20:14:44.740Z", finishedAt: "2026-09-03T20:14:46.356Z", stage: "dispatch", status: "succeeded", traceId: TRACE },
        { id: "r0", startedAt: "2026-09-03T20:14:47.000Z", finishedAt: "2026-09-03T20:14:48.000Z", stage: "pipeline", status: "skipped", errorClass: "no_scored_signals", traceId: TRACE },
      ])
      .run();

    expect((await getRunProgress(ctx.db, TRACE))?.status).toBe("succeeded");
  });

  it("attaches the trace's script, its render and its export as one video", async () => {
    await seedSignal(ctx);
    await seedFootage(ctx);
    await ctx.db.insert(runs).values({ id: "r1", startedAt: "2026-08-31T10:00:00.000Z", finishedAt: "2026-08-31T10:05:00.000Z", stage: "export", status: "succeeded", traceId: TRACE }).run();
    await ctx.db
      .insert(scripts)
      .values({
        id: "scr1",
        signalId: "sig1",
        hook: "Your city is watching you sleep.",
        body: "Councils bought the cameras quietly, and the city never voted on it.",
        debateQuestion: "Would you have voted for it?",
        wordCount: 140,
        status: "approved",
        traceId: TRACE,
        createdAt: "2026-08-31T10:00:30.000Z",
      })
      .run();
    await ctx.db
      .insert(renders)
      .values({ id: "rn1", scriptId: "scr1", footageSegmentId: "seg1", ttsDriver: "edge", ttsVoice: "en-US-AvaNeural", durationS: 47.5, status: "rendered", createdAt: "2026-08-31T10:04:00.000Z" })
      .run();
    await ctx.db
      .insert(exportsTable)
      .values({
        id: "ex1",
        renderId: "rn1",
        storageKey: "exports/ex1.mp4",
        sizeBytes: 4_200_000,
        suggestedTitle: "The city is watching",
        suggestedDescription: "d",
        suggestedTagsJson: "[]",
        auditJson: "{}",
        createdAt: "2026-08-31T10:05:00.000Z",
        expiresAt: "2026-09-03T10:05:00.000Z",
        status: "ready_for_review",
      })
      .run();

    const progress = await getRunProgress(ctx.db, TRACE);

    expect(progress?.videos).toHaveLength(1);
    const video = progress?.videos[0];
    expect(video?.scriptId).toBe("scr1");
    expect(video?.renderId).toBe("rn1");
    expect(video?.exportId).toBe("ex1");
    expect(video?.exportStatus).toBe("ready_for_review");
    expect(video?.ttsVoice).toBe("en-US-AvaNeural");
    expect(video?.keywords.length).toBeGreaterThan(0);
    expect(video?.keywords).toContain("city");
  });

  it("shows a script with no render yet as a video in progress, not as a missing one", async () => {
    await seedSignal(ctx);
    await ctx.db.insert(runs).values({ id: "r1", startedAt: "2026-08-31T10:00:00.000Z", stage: "tts", status: "running", traceId: TRACE }).run();
    await ctx.db
      .insert(scripts)
      .values({ id: "scr1", signalId: "sig1", hook: "h", body: "b", debateQuestion: "q", wordCount: 3, status: "draft", traceId: TRACE, createdAt: "2026-08-31T10:00:30.000Z" })
      .run();

    const progress = await getRunProgress(ctx.db, TRACE);

    expect(progress?.videos).toHaveLength(1);
    expect(progress?.videos[0].renderId).toBeNull();
    expect(progress?.videos[0].exportId).toBeNull();
  });

  it("carries the shot plan, in plan order, with the status each shot actually reached", async () => {
    // Stage 5's contract: it shows what the pipeline recorded. These
    // statuses are rows SOURCE wrote after doing the thing, never
    // predictions, so the panel can never claim a shot is downloading when
    // nothing has been requested.
    await seedSignal(ctx);
    await ctx.db.insert(runs).values({ id: "r1", startedAt: "2026-08-31T10:00:00.000Z", stage: "footage_select", status: "running", traceId: TRACE }).run();
    await ctx.db
      .insert(scripts)
      .values({ id: "scr1", signalId: "sig1", hook: "h", body: "b", debateQuestion: "q", wordCount: 3, status: "draft", traceId: TRACE, createdAt: "2026-08-31T10:00:30.000Z" })
      .run();
    await saveShotPlan(
      ctx.client,
      "scr1",
      TRACE,
      [
        { position: 0, beatIndex: null, intent: "opening", query: "city street crowd walking", source: "pexels" },
        { position: 1, beatIndex: 0, intent: "the real thing", query: "GTA 6 walkthrough gameplay", source: "youtube" },
      ],
      "2026-08-31T10:00:31.000Z",
    );
    await advanceShot(ctx.db, "scr1", 0, "clipped", "2026-08-31T10:00:40.000Z", { footageSegmentId: "seg1" });
    await advanceShot(ctx.db, "scr1", 1, "failed", "2026-08-31T10:00:45.000Z", { error: "no long-form result" });

    const progress = await getRunProgress(ctx.db, TRACE);
    const shots = progress?.videos[0].shots ?? [];

    expect(shots.map((shot) => shot.position)).toEqual([0, 1]);
    expect(shots[0]).toMatchObject({ status: "clipped", source: "pexels", query: "city street crowd walking", error: null });
    expect(shots[1]).toMatchObject({ status: "failed", source: "youtube", error: "no long-form result" });
  });

  it("reports no shots at all before PLAN has run, rather than inventing placeholders", async () => {
    await seedSignal(ctx);
    await ctx.db.insert(runs).values({ id: "r1", startedAt: "2026-08-31T10:00:00.000Z", stage: "script", status: "running", traceId: TRACE }).run();
    await ctx.db
      .insert(scripts)
      .values({ id: "scr1", signalId: "sig1", hook: "h", body: "b", debateQuestion: "q", wordCount: 3, status: "draft", traceId: TRACE, createdAt: "2026-08-31T10:00:30.000Z" })
      .run();

    const progress = await getRunProgress(ctx.db, TRACE);
    expect(progress?.videos[0].shots).toEqual([]);
  });

  it("does not attribute another trace's script to this run", async () => {
    await seedSignal(ctx);
    await ctx.db.insert(runs).values({ id: "r1", startedAt: "2026-08-31T10:00:00.000Z", stage: "script", status: "running", traceId: TRACE }).run();
    await ctx.db
      .insert(scripts)
      .values({ id: "scr-other", signalId: "sig1", hook: "h", body: "b", debateQuestion: "q", wordCount: 3, status: "draft", traceId: "some-other-trace", createdAt: "2026-08-31T10:00:30.000Z" })
      .run();

    const progress = await getRunProgress(ctx.db, TRACE);

    expect(progress?.videos).toEqual([]);
  });
});

describe("listRecentRuns", () => {
  let ctx: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    ctx = createTestDb();
    applyMigrations(ctx.client);
  });

  it("groups run rows by trace, newest first, and counts each trace's videos", async () => {
    await seedSignal(ctx);
    await ctx.db
      .insert(runs)
      .values([
        { id: "a1", startedAt: "2026-08-31T09:00:00.000Z", finishedAt: "2026-08-31T09:01:00.000Z", stage: "script", status: "succeeded", traceId: "older" },
        { id: "b1", startedAt: "2026-08-31T11:00:00.000Z", finishedAt: "2026-08-31T11:01:00.000Z", stage: "research", status: "succeeded", traceId: "newer" },
        { id: "b2", startedAt: "2026-08-31T11:02:00.000Z", stage: "script", status: "running", traceId: "newer" },
      ])
      .run();
    await ctx.db
      .insert(scripts)
      .values({ id: "scr1", signalId: "sig1", hook: "h", body: "b", debateQuestion: "q", wordCount: 3, status: "draft", traceId: "newer", createdAt: "2026-08-31T11:02:30.000Z" })
      .run();

    const recent = await listRecentRuns(ctx.db);

    expect(recent.map((run) => run.traceId)).toEqual(["newer", "older"]);
    expect(recent[0]).toMatchObject({ status: "running", videoCount: 1 });
    expect(recent[1]).toMatchObject({ status: "succeeded", videoCount: 0 });
  });

  it("returns an empty list on a fresh install rather than a placeholder run", async () => {
    expect(await listRecentRuns(ctx.db)).toEqual([]);
  });
});
