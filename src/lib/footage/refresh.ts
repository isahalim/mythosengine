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
 * current top long-form video, skips downloading anything already
 * represented in footage_segments, clips the highest-motion windows, and
 * commits each to the assets-library branch with provenance metadata. The
 * full downloaded source video is deleted once clipping is done — the
 * library holds only the trimmed, transformed segments, never the source.
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

  const videoResult = await drivers.search.findTopLongFormVideo({
    channelHandle: extractHandle(footageSource.channelUrl),
    minDurationS: minSourceDurationS,
  });
  if (!videoResult.ok) {
    return { footageSourceId: footageSource.id, status: "failed", newSegments: 0, error: videoResult.error };
  }
  if (videoResult.value === null) {
    return { footageSourceId: footageSource.id, status: "skipped_no_eligible_video", newSegments: 0 };
  }
  const video = videoResult.value;

  const existing = await db
    .select()
    .from(footageSegments)
    .where(eq(footageSegments.sourceVideoId, video.videoId))
    .all();
  if (existing.length > 0) {
    return { footageSourceId: footageSource.id, status: "skipped_already_have_video", newSegments: 0 };
  }

  const downloadResult = await drivers.download.fetchVideo({
    url: `https://www.youtube.com/watch?v=${video.videoId}`,
    maxDurationS: minSourceDurationS * 20, // a generous ceiling, not the eligibility floor
  });
  if (!downloadResult.ok) {
    return { footageSourceId: footageSource.id, status: "failed", newSegments: 0, error: downloadResult.error };
  }
  const downloadedPath = downloadResult.value.filePath;

  const motionResult = await computeMotionSeries(downloadedPath);
  if (!motionResult.ok) {
    return { footageSourceId: footageSource.id, status: "failed", newSegments: 0, error: motionResult.error };
  }
  const windows = findTopMotionWindows(motionResult.value, clipDurationS, candidatesPerVideo);

  const worktreeDir = await mkdtemp(join(tmpdir(), "footage-refresh-worktree-"));
  await rm(worktreeDir, { recursive: true, force: true });
  const worktreeResult = await ensureLibraryWorktree(repoDir, worktreeDir);
  if (!worktreeResult.ok) {
    return { footageSourceId: footageSource.id, status: "failed", newSegments: 0, error: worktreeResult.error };
  }

  let newSegments = 0;
  const nowIso = new Date().toISOString();

  for (const window of windows) {
    const segmentId = `${footageSource.id}-${video.videoId}-${window.startS}`;
    const clipTempPath = join(worktreeDir, "..", `${segmentId}.mp4`);
    const clipResult = await extractClip(downloadedPath, window.startS, clipDurationS, clipTempPath);
    if (!clipResult.ok) continue; // one bad clip shouldn't abort the whole refresh

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

  await removeLibraryWorktree(repoDir, worktreeDir);
  await rm(downloadedPath, { force: true });

  return {
    footageSourceId: footageSource.id,
    status: newSegments > 0 ? "refreshed" : "failed",
    newSegments,
    error: newSegments > 0 ? undefined : { kind: "invalid_response", message: "no clips could be committed", retryable: true },
  };
}
