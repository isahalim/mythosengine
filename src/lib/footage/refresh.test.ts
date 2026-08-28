import { execFile, execSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../../../db/apply-migrations.ts";
import { createTestDb } from "../../../db/client.ts";
import { footageSegments, footageSources } from "../../../db/schema.ts";
import type { DownloadDriver, YoutubeSearchDriver } from "../drivers/types.ts";
import { err, ok } from "../result.ts";
import { refreshFootageSource } from "./refresh.ts";

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
    findTopLongFormVideo: async () =>
      ok({ videoId: "vid123", title: "Full GTA V Walkthrough", durationS: 3600, viewCount: 1_000_000 }),
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
        { clipDurationS: 2, candidatesPerVideo: 2, repoDir },
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
    const noVideoSearch: YoutubeSearchDriver = { findTopLongFormVideo: async () => ok(null) };

    const result = await refreshFootageSource(ctx.db, source, { search: noVideoSearch, download: fakeDownload(sourceVideoPath) }, { repoDir });
    expect(result.status).toBe("skipped_no_eligible_video");
  });

  it("reports failed with the driver error when search itself fails", async () => {
    const source = ctx.db.select().from(footageSources).all()[0];
    const failingSearch: YoutubeSearchDriver = {
      findTopLongFormVideo: async () => err({ kind: "provider_error", message: "quota exceeded", retryable: true }),
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

  it("reports failed when the library worktree can't be created (bad repoDir)", async () => {
    const source = ctx.db.select().from(footageSources).all()[0];
    if (!hasFfmpeg()) return;

    const result = await refreshFootageSource(
      ctx.db,
      source,
      { search: fakeSearch, download: fakeDownload(sourceVideoPath) },
      { repoDir: "/definitely/not/a/real/git/repo/path", clipDurationS: 2, candidatesPerVideo: 1 },
    );
    expect(result.status).toBe("failed");
  });
});
