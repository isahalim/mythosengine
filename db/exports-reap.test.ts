import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "./client.ts";
import { applyMigrations } from "./apply-migrations.ts";
import { exports as exportsTable, footageSegments, footageSources, renderFootageParts, renders, scripts, signals, sources } from "./schema.ts";
import { findExpiredExports, reapExpiredExports } from "./exports-reap.ts";

const NOW = Date.parse("2026-09-01T00:00:00.000Z");

describe("the expired-export sweep", () => {
  let ctx: ReturnType<typeof createTestDb>;

  async function seed(id: string, status: string, expiresAt: string): Promise<void> {
    await ctx.db
      .insert(exportsTable)
      .values({
        id,
        renderId: "ren1",
        storageKey: `exports/${id}.mp4`,
        sizeBytes: 100,
        suggestedTitle: "t",
        suggestedDescription: "d",
        suggestedTagsJson: "[]",
        auditJson: "{}",
        createdAt: "2026-08-01T00:00:00.000Z",
        expiresAt,
        status: status as "ready_for_review",
      })
      .run();
  }

  beforeEach(async () => {
    ctx = createTestDb();
    applyMigrations(ctx.client);
    await ctx.db.insert(sources).values({ id: "src1", kind: "reddit", url: "http://x" }).run();
    await ctx.db.insert(signals).values({ id: "sig1", sourceId: "src1", canonicalUrl: "http://x/1", title: "t", observedAt: "2026-01-01", engagementScore: 1, simhash: "a", state: "exported" }).run();
    await ctx.db.insert(scripts).values({ id: "scr1", signalId: "sig1", hook: "h", body: "b", debateQuestion: "q", wordCount: 10, status: "approved", createdAt: "2026-01-01" }).run();
    await ctx.db.insert(footageSources).values({ id: "fsrc1", channelUrl: "http://y", game: "gta", licenseNote: "owned" }).run();
    await ctx.db.insert(footageSegments).values({ id: "fseg1", footageSourceId: "fsrc1", sourceVideoId: "v1", clipStartS: 0, clipEndS: 10, motionScore: 1, libraryPath: "p", fetchedAt: "2026-01-01" }).run();
    await ctx.db.insert(renders).values({ id: "ren1", scriptId: "scr1", footageSegmentId: "fseg1", ttsDriver: "edge", ttsVoice: "v", status: "rendered", createdAt: "2026-01-01" }).run();
  });

  it("finds only rows that are past their window AND still hold bytes", async () => {
    await seed("live", "ready_for_review", "2026-09-05T00:00:00.000Z");
    await seed("past-review", "reviewed", "2026-08-30T00:00:00.000Z");
    await seed("past-downloaded", "downloaded", "2026-08-30T00:00:00.000Z");
    // Already freed at discard time, and already swept — sweeping either
    // again would delete an object some other row may now own.
    await seed("already-discarded", "discarded", "2026-08-30T00:00:00.000Z");
    await seed("already-expired", "expired", "2026-08-30T00:00:00.000Z");

    const found = (await findExpiredExports(ctx.db, () => NOW)).map((row) => row.id).sort();

    expect(found).toEqual(["past-downloaded", "past-review"]);
  });

  it("frees the blob and marks the row expired, in that order", async () => {
    await seed("old", "ready_for_review", "2026-08-30T00:00:00.000Z");
    const deleted: string[] = [];

    const result = await reapExpiredExports(ctx.db, async (key) => {
      // The row must still be live at the moment the blob goes: a row marked
      // expired before the delete succeeds is a storage leak nothing records.
      const row = await ctx.db.select().from(exportsTable).all();
      expect(row[0].status).toBe("ready_for_review");
      deleted.push(key);
      return { ok: true };
    }, () => NOW);

    expect(result).toEqual({ retired: 1, failures: [], segmentsFreed: 0 });
    expect(deleted).toEqual(["exports/old.mp4"]);
    expect((await ctx.db.select().from(exportsTable).all())[0].status).toBe("expired");
  });

  it("leaves the row live when the blob will not delete, and reports why", async () => {
    await seed("stuck", "reviewed", "2026-08-30T00:00:00.000Z");

    const result = await reapExpiredExports(ctx.db, () => Promise.resolve({ ok: false, error: "network: timed out" }), () => NOW);

    expect(result.retired).toBe(0);
    expect(result.failures).toEqual([{ id: "stuck", error: "network: timed out" }]);
    // Still live, so the next run tries again rather than orphaning the object.
    expect((await ctx.db.select().from(exportsTable).all())[0].status).toBe("reviewed");
  });

  it("retires what it can when one of several fails", async () => {
    await seed("a", "reviewed", "2026-08-30T00:00:00.000Z");
    await seed("b", "reviewed", "2026-08-30T00:00:00.000Z");

    const result = await reapExpiredExports(
      ctx.db,
      (key) => Promise.resolve(key === "exports/a.mp4" ? { ok: true } : { ok: false, error: "boom" }),
      () => NOW,
    );

    expect(result.retired).toBe(1);
    expect(result.failures).toHaveLength(1);
  });
});

describe("footage that outlives nothing", () => {
  let ctx: ReturnType<typeof createTestDb>;

  /** A montage render: one primary segment plus three more, all four in render_footage_parts. */
  async function seedMontage(): Promise<void> {
    await ctx.db.insert(sources).values({ id: "src1", kind: "reddit", url: "http://x" }).run();
    await ctx.db.insert(signals).values({ id: "sig1", sourceId: "src1", canonicalUrl: "http://x/1", title: "t", observedAt: "2026-01-01", engagementScore: 1, simhash: "a", state: "exported" }).run();
    await ctx.db.insert(scripts).values({ id: "scr1", signalId: "sig1", hook: "h", body: "b", debateQuestion: "q", wordCount: 10, status: "approved", createdAt: "2026-01-01" }).run();
    await ctx.db.insert(footageSources).values({ id: "pexels-stock", channelUrl: "https://www.pexels.com/videos/", game: "stock:pexels", licenseNote: "n", kind: "stock" }).run();

    for (let i = 0; i < 4; i++) {
      await ctx.db
        .insert(footageSegments)
        .values({ id: `seg${i}`, footageSourceId: "pexels-stock", sourceVideoId: `v${i}`, clipStartS: 0, clipEndS: 10, motionScore: 0, libraryPath: `https://player.pexels.com/${i}.mp4`, fetchedAt: "2026-01-01" })
        .run();
    }
    await ctx.db.insert(renders).values({ id: "ren1", scriptId: "scr1", footageSegmentId: "seg0", ttsDriver: "edge", ttsVoice: "v", status: "rendered", createdAt: "2026-01-01" }).run();
    for (let i = 0; i < 4; i++) {
      await ctx.db
        .insert(renderFootageParts)
        .values({ id: `part${i}`, renderId: "ren1", position: i, footageSegmentId: `seg${i}`, startMs: i * 1000, endMs: (i + 1) * 1000 })
        .run();
    }
  }

  beforeEach(async () => {
    ctx = createTestDb();
    applyMigrations(ctx.client);
    await seedMontage();
  });

  async function expire(expiresAt: string): Promise<void> {
    await ctx.db
      .insert(exportsTable)
      .values({
        id: "exp1",
        renderId: "ren1",
        storageKey: "exports/exp1.mp4",
        sizeBytes: 1,
        suggestedTitle: "t",
        suggestedDescription: "d",
        suggestedTagsJson: "[]",
        auditJson: "{}",
        createdAt: "2026-08-01T00:00:00.000Z",
        expiresAt,
        status: "ready_for_review",
      })
      .run();
  }

  it("keeps every footage row while the video is still reviewable", async () => {
    // §9: for as long as there is a video to review, its footage provenance
    // has to be readable. Sweeping early would make an export unauditable.
    await expire("2126-01-01T00:00:00.000Z");
    const result = await reapExpiredExports(ctx.db, async () => ({ ok: true }), () => NOW);

    expect(result.retired).toBe(0);
    expect(result.segmentsFreed).toBe(0);
    expect(await ctx.db.select().from(footageSegments).all()).toHaveLength(4);
    expect(await ctx.db.select().from(renderFootageParts).all()).toHaveLength(4);
  });

  it("drops the montage's clips the moment its video expires", async () => {
    await expire("2026-08-03T00:00:00.000Z");
    const result = await reapExpiredExports(ctx.db, async () => ({ ok: true }), () => NOW);

    expect(result.retired).toBe(1);
    expect(await ctx.db.select().from(renderFootageParts).all()).toEqual([]);
    // seg0 survives: renders.footage_segment_id is NOT NULL and restricting,
    // and the render row has to stay for the diversity queries. The other
    // three are gone, and no media was ever stored for any of them.
    expect(result.segmentsFreed).toBe(3);
    expect((await ctx.db.select().from(footageSegments).all()).map((r) => r.id)).toEqual(["seg0"]);
  });

  it("leaves a blob it could not delete alone, rows and all, for the next sweep", async () => {
    await expire("2026-08-03T00:00:00.000Z");
    const result = await reapExpiredExports(ctx.db, async () => ({ ok: false, error: "R2 said no" }), () => NOW);

    expect(result.retired).toBe(0);
    expect(result.failures).toHaveLength(1);
    // The export is still live, so its provenance must still be readable.
    expect(await ctx.db.select().from(renderFootageParts).all()).toHaveLength(4);
    expect(await ctx.db.select().from(footageSegments).all()).toHaveLength(4);
  });
});
