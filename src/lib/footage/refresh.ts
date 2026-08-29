import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { DownloadDriver, DriverError, YoutubeSearchDriver } from "../drivers/types.ts";
import { extractClip } from "./clip.ts";
import { commitClipToLibrary, ensureLibraryWorktree, removeLibraryWorktree } from "./library.ts";
import { computeMotionSeries, findTopMotionWindows } from "./motion-score.ts";
import { footageSegments, footageSources } from "../../../db/schema.ts";
import type { AppDb } from "../../../db/client.ts";

type Db = AppDb;
type FootageSource = typeof footageSources.$inferSelect;

export interface RefreshOptions {
  clipDurationS?: number;
  candidatesPerVideo?: number;
  minSourceDurationS?: number;
  repoDir?: string;
}

export interface RefreshResult {
  footageSourceId: string;
  status: "skipped_no_eligible_video" | "skipped_already_have_video" | "refreshed" | "failed";
  newSegments: number;
  error?: DriverError;
}

function extractHandle(channelUrl: string): string {
  const match = /\/@([^/?]+)/.exec(channelUrl);
  return match ? match[1] : channelUrl;
}

/**
 * FOOTAGE REFRESH (ARCHITECTURE.md §5.0) for one tracked channel: finds its
 * ranked candidate long-form videos, skips ones already represented in
 * footage_segments, and tries each remaining candidate in order until one
 * downloads and clips successfully — one candidate being age-restricted,
 * removed, or transiently unavailable (all observed live, 2026-08-29)
 * shouldn't fail the whole channel's weekly refresh when the search API
 * already returned a ranked pool of alternates. Each attempt's downloaded
 * source video is deleted once clipping is done — the library holds only
 * the trimmed, transformed segments, never the source.
 */
export async function refreshFootageSource(
  db: Db,
  footageSource: FootageSource,
  drivers: { search: YoutubeSearchDriver; download: DownloadDriver },
  options: RefreshOptions = {},
): Promise<RefreshResult> {
  const clipDurationS = options.clipDurationS ?? 20;
  const candidatesPerVideo = options.candidatesPerVideo ?? 3;
  const minSourceDurationS = options.minSourceDurationS ?? 1200;
  const repoDir = options.repoDir ?? process.cwd();

  const videosResult = await drivers.search.findTopLongFormVideos({
    channelHandle: extractHandle(footageSource.channelUrl),
    minDurationS: minSourceDurationS,
  });
  if (!videosResult.ok) {
    return { footageSourceId: footageSource.id, status: "failed", newSegments: 0, error: videosResult.error };
  }
  if (videosResult.value.length === 0) {
    return { footageSourceId: footageSource.id, status: "skipped_no_eligible_video", newSegments: 0 };
  }

  // Created lazily on the first candidate actually worth attempting, so the
  // all-candidates-already-downloaded case (common on a re-run) never pays
  // for a worktree it doesn't need.
  let worktreeDir: string | undefined;
  let lastError: DriverError | undefined;
  let sawOnlyAlreadyHave = true;

  for (const video of videosResult.value) {
    const existing = await db.select().from(footageSegments).where(eq(footageSegments.sourceVideoId, video.videoId)).all();
    if (existing.length > 0) continue;
    sawOnlyAlreadyHave = false;

    if (worktreeDir === undefined) {
      const dir = await mkdtemp(join(tmpdir(), "footage-refresh-worktree-"));
      await rm(dir, { recursive: true, force: true });
      const worktreeResult = await ensureLibraryWorktree(repoDir, dir);
      if (!worktreeResult.ok) {
        return { footageSourceId: footageSource.id, status: "failed", newSegments: 0, error: worktreeResult.error };
      }
      worktreeDir = dir;
    }

    const downloadResult = await drivers.download.fetchVideo({
      url: `https://www.youtube.com/watch?v=${video.videoId}`,
      maxDurationS: minSourceDurationS * 20, // a generous ceiling, not the eligibility floor
    });
    if (!downloadResult.ok) {
      lastError = downloadResult.error;
      continue;
    }
    const downloadedPath = downloadResult.value.filePath;

    const motionResult = await computeMotionSeries(downloadedPath);
    if (!motionResult.ok) {
      lastError = motionResult.error;
      await rm(downloadedPath, { force: true });
      continue;
    }
    const windows = findTopMotionWindows(motionResult.value, clipDurationS, candidatesPerVideo);

    let newSegments = 0;
    const nowIso = new Date().toISOString();

    for (const window of windows) {
      const segmentId = `${footageSource.id}-${video.videoId}-${window.startS}`;
      const clipTempPath = join(worktreeDir, "..", `${segmentId}.mp4`);
      const clipResult = await extractClip(downloadedPath, window.startS, clipDurationS, clipTempPath);
      if (!clipResult.ok) continue; // one bad clip shouldn't abort the whole video

      const libraryRelativePath = `clips/${footageSource.id}/${segmentId}.mp4`;
      const commitResult = await commitClipToLibrary(
        worktreeDir,
        clipTempPath,
        libraryRelativePath,
        {
          footageSourceId: footageSource.id,
          sourceVideoId: video.videoId,
          clipStartS: window.startS,
          clipEndS: window.startS + clipDurationS,
          motionScore: window.score,
          fetchedAt: nowIso,
        },
      );
      await rm(clipTempPath, { force: true });
      if (!commitResult.ok) continue;

      await db
        .insert(footageSegments)
        .values({
          id: segmentId,
          footageSourceId: footageSource.id,
          sourceVideoId: video.videoId,
          clipStartS: window.startS,
          clipEndS: window.startS + clipDurationS,
          motionScore: window.score,
          libraryPath: libraryRelativePath,
          fetchedAt: nowIso,
        })
        .onConflictDoNothing()
        .run();
      newSegments++;
    }

    await rm(downloadedPath, { force: true });

    if (newSegments > 0) {
      await removeLibraryWorktree(repoDir, worktreeDir);
      return { footageSourceId: footageSource.id, status: "refreshed", newSegments };
    }
    lastError = { kind: "invalid_response", message: `no clips could be committed for video ${video.videoId}`, retryable: true };
  }

  if (worktreeDir !== undefined) await removeLibraryWorktree(repoDir, worktreeDir);

  if (sawOnlyAlreadyHave) {
    return { footageSourceId: footageSource.id, status: "skipped_already_have_video", newSegments: 0 };
  }
  return {
    footageSourceId: footageSource.id,
    status: "failed",
    newSegments: 0,
    error: lastError ?? { kind: "invalid_response", message: "no eligible candidate could be refreshed", retryable: true },
  };
}
