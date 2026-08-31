import { execFile, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../../../db/apply-migrations.ts";
import { createTestDb } from "../../../db/client.ts";
import { footageSegments, footageSources } from "../../../db/schema.ts";
import type { DownloadDriver, YoutubeSearchDriver } from "../drivers/types.ts";
import { err, ok } from "../result.ts";
import { refreshFootageSource, sampleMotionWindows } from "./refresh.ts";

const execFileAsync = promisify(execFile);

function hasFfmpeg(): boolean {
  try {
    execSync("which ffmpeg", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("refreshFootageSource (real ffmpeg + real scratch git repo)", () => {
  let ctx: ReturnType<typeof createTestDb>;
  let repoDir: string;
  let sourceVideoPath: string;

  const fakeSearch: YoutubeSearchDriver = {
    findTopLongFormVideos: async () =>
      ok([{ videoId: "vid123", title: "Full GTA V Walkthrough", durationS: 3600, viewCount: 1_000_000 }]),
  };

  function fakeDownload(videoPath: string): DownloadDriver {
    return {
      fetchVideo: async () => ok({ filePath: videoPath, durationS: 8, sourceVideoId: "vid123" }),
    };
  }

  beforeEach(async () => {
    ctx = createTestDb();
    applyMigrations(ctx.client);
    ctx.db
      .insert(footageSources)
      .values({ id: "hollowpoiint-gta", channelUrl: "https://www.youtube.com/@HollowPoiint", game: "gta-v", licenseNote: "test" })
      .run();

    repoDir = await mkdtemp(join(tmpdir(), "footage-refresh-repo-"));
    await execFileAsync("git", ["init", "--initial-branch=main", "--quiet"], { cwd: repoDir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: repoDir });
    await writeFile(join(repoDir, "README.md"), "placeholder\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: repoDir });
    await execFileAsync("git", ["commit", "-m", "init", "--quiet"], { cwd: repoDir });

    // A short synthetic "downloaded video" standing in for a real long-form
    // walkthrough -- proves the real ffmpeg motion-scoring/clipping chain,
    // not just that fake drivers were called.
    const videoDir = await mkdtemp(join(tmpdir(), "footage-refresh-video-"));
    sourceVideoPath = join(videoDir, "source.mp4");
    if (hasFfmpeg()) {
      await execFileAsync("ffmpeg", [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=duration=8:size=320x240:rate=15",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        sourceVideoPath,
      ]);
    }
  });

  afterEach(async () => {
    ctx.client.close();
    await rm(repoDir, { recursive: true, force: true });
    await rm(sourceVideoPath, { force: true }).catch(() => undefined);
  });

  it.skipIf(!hasFfmpeg())(
    "discovers, clips, and commits real footage segments end to end",
    async () => {
      const source = ctx.db.select().from(footageSources).all()[0];
      const result = await refreshFootageSource(
        ctx.db,
        source,
        { search: fakeSearch, download: fakeDownload(sourceVideoPath) },
        // headTailBufferS is scaled to the 8s synthetic source the way the
        // 600s production default is scaled to a ~1h episode.
        { clipDurationS: 2, candidatesPerVideo: 2, headTailBufferS: 1, repoDir },
      );

      expect(result.status).toBe("refreshed");
      expect(result.newSegments).toBeGreaterThan(0);

      const rows = ctx.db.select().from(footageSegments).all();
      expect(rows.length).toBe(result.newSegments);
      expect(rows.every((r) => r.sourceVideoId === "vid123")).toBe(true);
      expect(rows.every((r) => r.footageSourceId === "hollowpoiint-gta")).toBe(true);

      // the committed clips are real, playable files on the assets-library branch
      const { stdout } = await execFileAsync("git", ["show", `assets-library:${rows[0].libraryPath}`], {
        cwd: repoDir,
        maxBuffer: 10 * 1024 * 1024,
        encoding: "buffer",
      } as never);
      expect((stdout as unknown as Buffer).byteLength).toBeGreaterThan(0);
    },
    30_000,
  );

  it("skips re-downloading when the video is already represented in footage_segments", async () => {
    const source = ctx.db.select().from(footageSources).all()[0];
    ctx.db
      .insert(footageSegments)
      .values({
        id: "existing",
        footageSourceId: "hollowpoiint-gta",
        sourceVideoId: "vid123",
        clipStartS: 0,
        clipEndS: 20,
        motionScore: 1,
        libraryPath: "clips/x.mp4",
        fetchedAt: new Date().toISOString(),
      })
      .run();

    const result = await refreshFootageSource(ctx.db, source, { search: fakeSearch, download: fakeDownload(sourceVideoPath) }, { repoDir });
    expect(result.status).toBe("skipped_already_have_video");
    expect(result.newSegments).toBe(0);
  });

  it("skips when the channel has no eligible long-form video", async () => {
    const source = ctx.db.select().from(footageSources).all()[0];
    const noVideoSearch: YoutubeSearchDriver = { findTopLongFormVideos: async () => ok([]) };

    const result = await refreshFootageSource(ctx.db, source, { search: noVideoSearch, download: fakeDownload(sourceVideoPath) }, { repoDir });
    expect(result.status).toBe("skipped_no_eligible_video");
  });

  it("reports failed with the driver error when search itself fails", async () => {
    const source = ctx.db.select().from(footageSources).all()[0];
    const failingSearch: YoutubeSearchDriver = {
      findTopLongFormVideos: async () => err({ kind: "provider_error", message: "quota exceeded", retryable: true }),
    };

    const result = await refreshFootageSource(ctx.db, source, { search: failingSearch, download: fakeDownload(sourceVideoPath) }, { repoDir });
    expect(result.status).toBe("failed");
    expect(result.error?.message).toBe("quota exceeded");
  });

  it("reports failed with the driver error when download fails", async () => {
    const source = ctx.db.select().from(footageSources).all()[0];
    const failingDownload: DownloadDriver = {
      fetchVideo: async () => err({ kind: "policy_violation", message: "too long", retryable: false }),
    };

    const result = await refreshFootageSource(ctx.db, source, { search: fakeSearch, download: failingDownload }, { repoDir });
    expect(result.status).toBe("failed");
    expect(result.error?.kind).toBe("policy_violation");
  });

  it.skipIf(!hasFfmpeg())("falls through to the next ranked candidate when the top one fails to download", async () => {
    const source = ctx.db.select().from(footageSources).all()[0];
    const twoCandidateSearch: YoutubeSearchDriver = {
      findTopLongFormVideos: async () =>
        ok([
          { videoId: "age-restricted-vid", title: "Top Video (age-restricted)", durationS: 3600, viewCount: 2_000_000 },
          { videoId: "vid123", title: "Full GTA V Walkthrough", durationS: 3600, viewCount: 1_000_000 },
        ]),
    };
    const fallthroughDownload: DownloadDriver = {
      fetchVideo: async (req) => {
        if (req.url.includes("age-restricted-vid")) {
          return err({ kind: "policy_violation", message: "Sorry, this content is age-restricted", retryable: false });
        }
        return ok({ filePath: sourceVideoPath, durationS: 8, sourceVideoId: "vid123" });
      },
    };

    const result = await refreshFootageSource(
      ctx.db,
      source,
      { search: twoCandidateSearch, download: fallthroughDownload },
      { clipDurationS: 2, candidatesPerVideo: 2, headTailBufferS: 1, repoDir },
    );

    expect(result.status).toBe("refreshed");
    expect(result.newSegments).toBeGreaterThan(0);
    const rows = ctx.db.select().from(footageSegments).all();
    expect(rows.every((r) => r.sourceVideoId === "vid123")).toBe(true);
  });

  it("reports failed when the library worktree can't be created (bad repoDir)", async () => {
    const source = ctx.db.select().from(footageSources).all()[0];
    if (!hasFfmpeg()) return;

    const result = await refreshFootageSource(
      ctx.db,
      source,
      { search: fakeSearch, download: fakeDownload(sourceVideoPath) },
      { repoDir: "/definitely/not/a/real/git/repo/path", clipDurationS: 2, candidatesPerVideo: 1, headTailBufferS: 1 },
    );
    expect(result.status).toBe("failed");
  });

  it("rejects an over-long candidate before downloading a single byte", async () => {
    const source = ctx.db.select().from(footageSources).all()[0];
    const longSearch: YoutubeSearchDriver = {
      findTopLongFormVideos: async () =>
        ok([{ videoId: "four-hour-vid", title: "Full Walkthrough (4h37m)", durationS: 16_620, viewCount: 9_000_000 }]),
    };
    // The exact shape the retired channels produced: a 4h37m candidate is
    // ~7.6 GB at 1080p, over the download driver's ceiling. Rejecting it
    // here means the ceiling is never reached, because the transfer never
    // starts.
    let downloadCalls = 0;
    const countingDownload: DownloadDriver = {
      fetchVideo: async () => {
        downloadCalls++;
        return ok({ filePath: sourceVideoPath, durationS: 16_620, sourceVideoId: "four-hour-vid" });
      },
    };

    const result = await refreshFootageSource(ctx.db, source, { search: longSearch, download: countingDownload }, { repoDir });

    expect(downloadCalls).toBe(0);
    expect(result.status).toBe("failed");
    expect(result.error?.kind).toBe("policy_violation");
    expect(result.error?.message).toContain("16620s");
  });

  it("rejects a candidate too short to survive both buffers plus a clip", async () => {
    const source = ctx.db.select().from(footageSources).all()[0];
    // 20 minutes clears the long-form floor but not 2x600s + a 65s clip.
    const shortSearch: YoutubeSearchDriver = {
      findTopLongFormVideos: async () => ok([{ videoId: "twenty-min", title: "Part 1", durationS: 1200, viewCount: 5000 }]),
    };
    let downloadCalls = 0;
    const countingDownload: DownloadDriver = {
      fetchVideo: async () => {
        downloadCalls++;
        return ok({ filePath: sourceVideoPath, durationS: 1200, sourceVideoId: "twenty-min" });
      },
    };

    const result = await refreshFootageSource(ctx.db, source, { search: shortSearch, download: countingDownload }, { repoDir });

    expect(downloadCalls).toBe(0);
    expect(result.status).toBe("failed");
    expect(result.error?.kind).toBe("policy_violation");
  });

  it.skipIf(!hasFfmpeg())("records clip timestamps against the original video, not the trimmed body", async () => {
    const source = ctx.db.select().from(footageSources).all()[0];

    const result = await refreshFootageSource(
      ctx.db,
      source,
      { search: fakeSearch, download: fakeDownload(sourceVideoPath) },
      { clipDurationS: 2, candidatesPerVideo: 2, headTailBufferS: 1, repoDir },
    );
    expect(result.status).toBe("refreshed");

    // Every window the sampler can return lives inside the 1s..7s body, so
    // once the offset is added back no clip may start before the buffer or
    // end after it. A clip at 0s would mean the offset was dropped and the
    // audit package is pointing a reviewer at the wrong moment.
    const rows = ctx.db.select().from(footageSegments).all();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.clipStartS).toBeGreaterThanOrEqual(1);
      expect(row.clipEndS).toBeLessThanOrEqual(7);
      expect(row.clipEndS - row.clipStartS).toBe(2);
    }
  });

  it.skipIf(!hasFfmpeg())("deletes both the download and the trimmed body when it is done", async () => {
    const source = ctx.db.select().from(footageSources).all()[0];
    const downloadCopy = join(await mkdtemp(join(tmpdir(), "footage-refresh-copy-")), "source.mp4");
    await copyFile(sourceVideoPath, downloadCopy);

    await refreshFootageSource(
      ctx.db,
      source,
      { search: fakeSearch, download: fakeDownload(downloadCopy) },
      { clipDurationS: 2, candidatesPerVideo: 1, headTailBufferS: 1, repoDir },
    );

    // The library keeps transformed segments, never third-party source
    // video — ARCHITECTURE.md §5.0.
    expect(existsSync(downloadCopy)).toBe(false);
    expect(existsSync(`${downloadCopy}.body.mp4`)).toBe(false);
  });
});

describe("sampleMotionWindows", () => {
  const ranked = Array.from({ length: 10 }, (_, i) => ({ startS: i * 100, score: 1000 - i }));

  it("only ever draws from the top of the ranking", () => {
    // random() === 0.999... always reaches for the last element of the pool,
    // so this is the worst case: even then nothing outside the shortlist can
    // be selected.
    const picked = sampleMotionWindows(ranked, 3, 4, () => 0.999);
    expect(picked.every((w) => ranked.slice(0, 4).includes(w))).toBe(true);
  });

  it("never returns the same window twice", () => {
    const picked = sampleMotionWindows(ranked, 5, 10, () => 0.5);
    expect(new Set(picked.map((w) => w.startS)).size).toBe(5);
  });

  it("varies with the random source — the whole point of sampling", () => {
    const first = sampleMotionWindows(ranked, 3, 10, () => 0).map((w) => w.startS);
    const second = sampleMotionWindows(ranked, 3, 10, () => 0.99).map((w) => w.startS);
    expect(first).not.toEqual(second);
  });

  it("widens the shortlist rather than returning fewer than asked for", () => {
    expect(sampleMotionWindows(ranked, 5, 2, () => 0.5)).toHaveLength(5);
  });

  it("returns what it can when the ranking is shorter than the request", () => {
    expect(sampleMotionWindows(ranked.slice(0, 2), 5, 10, () => 0.5)).toHaveLength(2);
  });

  it("returns nothing for an empty ranking rather than throwing", () => {
    expect(sampleMotionWindows([], 3, 10, () => 0.5)).toEqual([]);
  });
});
