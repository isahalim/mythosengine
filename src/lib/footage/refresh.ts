import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { DownloadDriver, DriverError, YoutubeSearchDriver } from "../drivers/types.ts";
import { extractClip, trimHeadTail } from "./clip.ts";
import { commitClipToLibrary, ensureLibraryWorktree, removeLibraryWorktree } from "./library.ts";
import { computeMotionSeries, findTopMotionWindows, type MotionWindow } from "./motion-score.ts";
import { footageSegments, footageSources } from "../../../db/schema.ts";
import type { AppDb } from "../../../db/client.ts";

type Db = AppDb;
type FootageSource = typeof footageSources.$inferSelect;

export interface RefreshOptions {
  /** Length of each committed clip. Default 65s — a Shorts narration runs ~60s, so one clip covers a whole render without RENDER's `-stream_loop` ever wrapping visibly. */
  clipDurationS?: number;
  candidatesPerVideo?: number;
  minSourceDurationS?: number;
  /** Refuse a source longer than this before downloading a byte. Default 2h. */
  maxSourceDurationS?: number;
  /** Dropped from the head and the tail of every source before anything is scored or clipped. Default 600s. */
  headTailBufferS?: number;
  /** How many of the highest-motion windows the random pick draws from. Default 12. */
  motionShortlistSize?: number;
  /** Injectable for tests; defaults to Math.random. */
  random?: () => number;
  repoDir?: string;
}

export interface RefreshResult {
  footageSourceId: string;
  status: "skipped_no_eligible_video" | "skipped_already_have_video" | "refreshed" | "failed";
  newSegments: number;
  error?: DriverError;
}

/**
 * Draws `count` windows at random from the `shortlistSize` highest-scoring
 * ones. Pure and injectable-random so it can be tested rather than
 * eyeballed.
 *
 * Why random at all: `findTopMotionWindows` is deterministic, so a channel
 * whose top video doesn't change between weekly refreshes yields the *same*
 * moments every time. Sampling from a shortlist keeps the "suitable"
 * property that motion scoring buys (no loading screens, no static
 * cutscene) while making the library actually vary across refreshes —
 * operator directive 2026-08-30. Ranking still decides what is eligible;
 * chance only decides which of the eligible ones we take.
 */
export function sampleMotionWindows(
  ranked: MotionWindow[],
  count: number,
  shortlistSize: number,
  random: () => number,
): MotionWindow[] {
  const shortlist = ranked.slice(0, Math.max(shortlistSize, count));
  const pool = [...shortlist];
  const picked: MotionWindow[] = [];
  while (picked.length < count && pool.length > 0) {
    const index = Math.min(pool.length - 1, Math.floor(random() * pool.length));
    picked.push(pool.splice(index, 1)[0]);
  }
  return picked;
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
 * already returned a ranked pool of alternates.
 *
 * Per the operator directive of 2026-08-30, each accepted source is
 * head/tail-trimmed by `headTailBufferS` the instant it lands and the full
 * download is deleted right then; motion scoring and clipping only ever see
 * the middle. Clips are `clipDurationS` long (65s by default — one covers a
 * whole Shorts narration) and are drawn at random from the highest-motion
 * windows rather than always being the top few, so a channel whose top
 * video is unchanged week to week still yields new footage.
 *
 * Neither the download nor the trimmed body survives the call — the library
 * holds only the transformed segments, never the source.
 */
export async function refreshFootageSource(
  db: Db,
  footageSource: FootageSource,
  drivers: { search: YoutubeSearchDriver; download: DownloadDriver },
  options: RefreshOptions = {},
): Promise<RefreshResult> {
  const clipDurationS = options.clipDurationS ?? 65;
  const candidatesPerVideo = options.candidatesPerVideo ?? 3;
  const minSourceDurationS = options.minSourceDurationS ?? 1200;
  const maxSourceDurationS = options.maxSourceDurationS ?? 7200;
  const headTailBufferS = options.headTailBufferS ?? 600;
  const motionShortlistSize = options.motionShortlistSize ?? 12;
  const random = options.random ?? Math.random;
  const repoDir = options.repoDir ?? process.cwd();

  // What a source has to be long enough for: both buffers, one clip, and
  // enough slack that the shortlist has more than one distinct window to
  // choose from. Checked against the search result's own duration, so an
  // unusable candidate costs nothing.
  const minUsableDurationS = 2 * headTailBufferS + clipDurationS;

  const videosResult = await drivers.search.findTopLongFormVideos({
    channelHandle: extractHandle(footageSource.channelUrl),
    minDurationS: minSourceDurationS,
    game: footageSource.game,
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

  // The candidate pool, before anything is attempted. Logged because this
  // job's only evidence is CI stdout, and on 2026-08-31 a run that tried
  // exactly one candidate and stopped could not say whether search had
  // returned one or the other two had been filtered — two very different
  // problems, indistinguishable from the outside.
  console.warn(
    `FOOTAGE REFRESH [${footageSource.id}]: ${videosResult.value.length} candidate(s): ` +
      videosResult.value.map((v) => `${v.videoId} (${v.durationS}s, ${v.viewCount} views)`).join(", "),
  );

  for (const video of videosResult.value) {
    const existing = await db.select().from(footageSegments).where(eq(footageSegments.sourceVideoId, video.videoId)).all();
    if (existing.length > 0) {
      console.warn(`FOOTAGE REFRESH [${footageSource.id}]: skipping ${video.videoId} — already in the library.`);
      continue;
    }
    sawOnlyAlreadyHave = false;

    // Rejected on the search result's stated duration, before a byte moves.
    // The ceiling is what keeps the pull inside "quickly downloaded at
    // 1080p" (operator directive 2026-08-30) — ~27 MB per source-minute
    // means 2h is already ~3.2 GB. The floor is the arithmetic one: a video
    // that cannot survive both 10-minute buffers plus a clip has nothing to
    // offer.
    if (video.durationS > maxSourceDurationS || video.durationS < minUsableDurationS) {
      const message = `candidate ${video.videoId} is ${video.durationS}s, outside the usable range ${minUsableDurationS}-${maxSourceDurationS}s`;
      console.warn(`FOOTAGE REFRESH [${footageSource.id}]: rejecting ${message}.`);
      lastError = { kind: "policy_violation", message, retryable: false };
      continue;
    }

    console.warn(`FOOTAGE REFRESH [${footageSource.id}]: attempting ${video.videoId} (${video.durationS}s).`);

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
      // The same ceiling the eligibility check above uses. The driver
      // re-checks it against the *converter's* reported duration, which is
      // the one that decides how many bytes actually arrive — YouTube's
      // search page and ytmp3 can disagree, and the byte cost follows ytmp3.
      maxDurationS: maxSourceDurationS,
    });
    if (!downloadResult.ok) {
      console.warn(`FOOTAGE REFRESH [${footageSource.id}]: ${video.videoId} failed to download (${downloadResult.error.kind}: ${downloadResult.error.message}); trying the next candidate.`);
      lastError = downloadResult.error;
      continue;
    }
    const downloadedPath = downloadResult.value.filePath;

    // Both ends come off immediately, before anything is scored or clipped
    // (operator directive 2026-08-30): the first and last 10 minutes of a
    // walkthrough episode are intro, recap, outro and subscribe card, none
    // of which is usable gameplay. Doing it here rather than by biasing the
    // window search means the discarded footage is gone from disk, not
    // merely unselected — nothing downstream can reach it by accident.
    const bodyPath = `${downloadedPath}.body.mp4`;
    const trimResult = await trimHeadTail(downloadedPath, downloadResult.value.durationS, headTailBufferS, bodyPath);
    await rm(downloadedPath, { force: true });
    if (!trimResult.ok) {
      lastError = trimResult.error;
      await rm(bodyPath, { force: true });
      continue;
    }
    // Timestamps inside the trimmed body are offset from the real video by
    // this much. Everything recorded as provenance adds it back, so the
    // audit package points at the moment in the *source* video a reviewer
    // would actually scrub to. Stream-copy trimming starts on a keyframe, so
    // this is accurate to a keyframe interval, not to the frame.
    const bodyOffsetS = trimResult.value.keptFromS;

    const motionResult = await computeMotionSeries(bodyPath);
    if (!motionResult.ok) {
      lastError = motionResult.error;
      await rm(bodyPath, { force: true });
      continue;
    }
    const windows = sampleMotionWindows(
      findTopMotionWindows(motionResult.value, clipDurationS, motionShortlistSize),
      candidatesPerVideo,
      motionShortlistSize,
      random,
    );

    let newSegments = 0;
    const nowIso = new Date().toISOString();

    for (const window of windows) {
      // Recorded against the original video's timeline, not the trimmed
      // body's — a reviewer opening the source expects these to be the
      // timestamps they can scrub to.
      const sourceStartS = bodyOffsetS + window.startS;
      const segmentId = `${footageSource.id}-${video.videoId}-${sourceStartS}`;
      const clipTempPath = join(worktreeDir, "..", `${segmentId}.mp4`);
      // Cut from the body, whose timeline is what `window.startS` indexes.
      const clipResult = await extractClip(bodyPath, window.startS, clipDurationS, clipTempPath);
      if (!clipResult.ok) continue; // one bad clip shouldn't abort the whole video

      const libraryRelativePath = `clips/${footageSource.id}/${segmentId}.mp4`;
      const commitResult = await commitClipToLibrary(
        worktreeDir,
        clipTempPath,
        libraryRelativePath,
        {
          footageSourceId: footageSource.id,
          sourceVideoId: video.videoId,
          clipStartS: sourceStartS,
          clipEndS: sourceStartS + clipDurationS,
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
          clipStartS: sourceStartS,
          clipEndS: sourceStartS + clipDurationS,
          motionScore: window.score,
          libraryPath: libraryRelativePath,
          fetchedAt: nowIso,
        })
        .onConflictDoNothing()
        .run();
      newSegments++;
    }

    await rm(bodyPath, { force: true });

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
