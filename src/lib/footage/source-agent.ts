import { copyFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { getOne, type AppDb } from "../../../db/client.ts";
import { footageSegments, footageSources } from "../../../db/schema.ts";
import { advanceShot } from "../../../db/shot-plans.ts";
import type { DownloadDriver, DriverError, SourcedVideo, YoutubeSearchDriver } from "../drivers/types.ts";
import type { PexelsClip, PexelsDriver } from "../drivers/pexels.ts";
import { probeVideo } from "../drivers/probe-video.ts";
import type { PlannedShot, ShotPlan } from "../pipeline/shot-plan.ts";
import { extractClip, trimHeadTail } from "./clip.ts";
import { computeMotionSeries, findTopMotionWindows } from "./motion-score.ts";
import { sampleMotionWindows } from "./refresh.ts";
import { findCachedSource, reserveCacheSlot } from "./source-cache.ts";
import { err, ok, type Result } from "../result.ts";

/**
 * SOURCE — executes a shot plan against YouTube and Pexels.
 *
 * The plan (src/lib/pipeline/shot-plan.ts) says what each shot should show
 * and where to look; this finds it, gets it onto disk, and cuts the piece
 * worth showing. Split from the planner deliberately: one is a language
 * problem and the other is a networking-and-ffmpeg problem, and mixing them
 * is how you end up unable to test either.
 *
 * **Provenance, since footage is now ephemeral.** No clip's bytes outlive
 * the render (operator direction 2026-09-01), so the rows are the only
 * record that a frame came from anywhere. Every clip gets a
 * `footage_segments` row naming its provider, its source video, the exact
 * window taken from it, and the query that found it — written before the
 * clip reaches the encoder, and dropped when the video expires
 * (db/exports-reap.ts).
 *
 * **What each source is for.** Pexels answers "an ordinary scene, shot
 * well": a search returns a short clip that is already the whole shot.
 * YouTube answers "the actual thing", and a YouTube result is an hour of
 * video with one usable minute in it — so the window is chosen by motion
 * scoring rather than taken from the front, which is where a channel puts
 * its intro.
 */

const PEXELS_SOURCE_ID = "pexels-stock";
const YOUTUBE_SOURCE_ID_PREFIX = "youtube";

/**
 * How many distinct YouTube videos one render may download.
 *
 * A hard cap, not a tuning knob. Each is potentially a gigabyte through a
 * converter site, on the operator's own laptop and their own connection; a
 * plan that asked for six YouTube shots without this would spend an hour
 * before the encoder started. Shots past the cap fall back to Pexels, which
 * is a worse picture and a finished video.
 */
const MAX_YOUTUBE_DOWNLOADS = 2;

/** Seconds cut from each end of a downloaded long-form video before anything is scored or clipped. */
const HEAD_TAIL_BUFFER_S = 120;
/** Length of one cut window. Long enough to cover a beat, short enough that several fit in one video. */
const WINDOW_S = 20;
/** How many top-motion windows the random pick draws from, for the viral path. */
const MOTION_SHORTLIST = 12;
/** A source shorter than this is not a walkthrough and has no interesting interior to find. */
const MIN_YOUTUBE_DURATION_S = 300;

export interface SourcedShot {
  /**
   * Position in the COMPOSITED order — contiguous from 0, because shots
   * that failed to source are not in this list.
   */
  position: number;
  /**
   * Position in the ORIGINAL plan, which is what `shot_plans` rows are keyed
   * by.
   *
   * The two diverge the moment one shot fails: plan shots 0, 1, 3 surviving
   * become composited positions 0, 1, 2. Advancing a row by the composited
   * position would then mark the FAILED shot as composited and leave the
   * real one stuck at `clipped` — stage 5 quietly showing the wrong shot as
   * being in the video, which is precisely the kind of claim this stage is
   * not allowed to make.
   */
  planPosition: number;
  beatIndex: number | null;
  intent: string;
  query: string;
  source: "youtube" | "pexels";
  /** `footage_segments.id` — the provenance row written before this reached the encoder. */
  segmentId: string;
  /** Where the bytes are, inside the render's own work directory. */
  filePath: string;
  durationS: number;
  provider: "pexels" | "youtube";
  providerClipId: string;
  /** Null for a YouTube clip, where the channel is the attribution. */
  photographer: string | null;
  pageUrl: string;
}

export interface SourceResult {
  shots: SourcedShot[];
  /** Shots that could not be sourced, with why. Reported, never swallowed — a montage with holes is the operator's business. */
  failures: { query: string; source: string; error: string }[];
}

export interface SourceDeps {
  db: AppDb;
  pexels: PexelsDriver;
  search: YoutubeSearchDriver;
  download: DownloadDriver;
  /** Where clips are written. The render's work directory, removed when the run ends. */
  workDir: string;
  /** Where the 24h source cache lives. */
  repoDir: string;
  nowIso: string;
  random?: () => number;
  /**
   * The script whose plan is being executed, so each shot's row advances as
   * it is really searched, downloaded and cut — which is what stage 5
   * displays. Absent in tests that are not exercising the plan rows.
   */
  scriptId?: string;
}

/**
 * Runs a plan.
 *
 * Partial success is a real outcome and is returned as one: a shot whose
 * query finds nothing is dropped and the shots around it hold longer, which
 * is a shorter montage rather than a failed render. Zero shots IS a failure
 * — there is nothing to composite — and it is returned as an error rather
 * than papered over with a stand-in nobody chose.
 */
export async function sourceShots(plan: ShotPlan, deps: SourceDeps): Promise<Result<SourceResult, DriverError>> {
  const failures: SourceResult["failures"] = [];
  const shots: SourcedShot[] = [];

  // YouTube work is grouped by query so a plan asking for the same footage
  // several times — which every `viral` plan does, by construction —
  // downloads once and cuts several windows out of it.
  const youtubeShots = plan.shots.filter((shot) => shot.source === "youtube");
  const byQuery = new Map<string, PlannedShot[]>();
  for (const shot of youtubeShots) {
    const existing = byQuery.get(shot.query);
    if (existing) existing.push(shot);
    else byQuery.set(shot.query, [shot]);
  }

  const sourcedByPosition = new Map<number, SourcedShot>();
  let downloadsUsed = 0;

  for (const [query, group] of byQuery) {
    const result = await sourceFromYoutube(query, group, deps, plan.origin === "viral_gameplay", MAX_YOUTUBE_DOWNLOADS - downloadsUsed);
    if (!result.ok) {
      // Not silently dropped. Every one of these falls through to Pexels
      // below, so the beat still gets a picture and the reviewer sees why
      // it is a stock image rather than the real thing.
      for (let i = 0; i < group.length; i++) failures.push({ query, source: "youtube", error: `${result.error.kind}: ${result.error.message}` });
      continue;
    }
    if (result.value.downloaded) downloadsUsed += 1;
    for (const sourced of result.value.shots) sourcedByPosition.set(sourced.position, sourced);
  }

  // Everything the plan sent to Pexels, plus every YouTube shot that did not
  // come back with footage. The fallback is the point: a beat with a stock
  // image is a beat with a picture.
  for (const shot of plan.shots) {
    if (sourcedByPosition.has(shot.position)) continue;
    if (shot.source === "youtube" && plan.origin === "viral_gameplay") continue; // viral is gameplay or nothing

    const result = await sourceFromPexels(shot, deps, sourcedByPosition);
    if (!result.ok) {
      failures.push({ query: shot.query, source: "pexels", error: `${result.error.kind}: ${result.error.message}` });
      await mark(deps, shot, "failed", { error: `${result.error.kind}: ${result.error.message}` });
      continue;
    }
    sourcedByPosition.set(shot.position, result.value);
  }

  for (const shot of [...sourcedByPosition.values()].sort((a, b) => a.position - b.position)) shots.push(shot);

  if (shots.length === 0) {
    return err({
      kind: "provider_error",
      message: `no shot in the plan could be sourced: ${failures.map((f) => `${f.query} (${f.error})`).join("; ")}`,
      retryable: true,
    });
  }

  // `position` is renumbered to the composited order so the timeline and
  // the provenance rows agree with the video. `planPosition` is left alone,
  // because it is what the `shot_plans` rows are keyed by.
  return ok({ shots: shots.map((shot, index) => ({ ...shot, position: index })), failures });
}

/**
 * Moves a shot's row along, when there is one.
 *
 * Every call sits immediately after the thing it reports, never before:
 * stage 5's contract is that it shows what the pipeline has recorded, and a
 * status written in advance of the work would be a prediction.
 */
async function mark(
  deps: SourceDeps,
  shot: { position: number },
  status: Parameters<typeof advanceShot>[3],
  extra: { footageSegmentId?: string; error?: string } = {},
): Promise<void> {
  if (deps.scriptId === undefined) return;
  await advanceShot(deps.db, deps.scriptId, shot.position, status, deps.nowIso, extra);
}

/** Idempotent source rows. One for Pexels; one per YouTube channel, so a clip's provenance names who filmed it. */
async function ensureSource(db: AppDb, row: typeof footageSources.$inferInsert): Promise<void> {
  const existing = await getOne(db.select().from(footageSources).where(eq(footageSources.id, row.id)));
  if (existing) return;
  await db.insert(footageSources).values(row).run();
}

/**
 * Finds, downloads and cuts a YouTube source, producing one clip per shot
 * in the group.
 *
 * Window selection is the whole difference between this and a naive cut:
 *
 * - `viral` takes windows at RANDOM from the top motion-scored shortlist,
 *   which is what the operator asked for ("clipped from random locations
 *   with buffers at the beginning and end") and what stops three videos in
 *   a row opening on the same twenty seconds of gameplay.
 * - everything else takes the highest-scoring windows outright, because a
 *   shot chosen to illustrate a beat should be the best available moment of
 *   that footage, not a random one.
 *
 * Both run after the head/tail buffer, so an intro, a sponsor read or an
 * outro card can never become a shot.
 */
async function sourceFromYoutube(
  query: string,
  group: PlannedShot[],
  deps: SourceDeps,
  viral: boolean,
  downloadBudget: number,
): Promise<Result<{ shots: SourcedShot[]; downloaded: boolean }, DriverError>> {
  for (const shot of group) await mark(deps, shot, "searching");

  const found = await deps.search.findTopLongFormVideos({ query, minDurationS: MIN_YOUTUBE_DURATION_S });
  if (!found.ok) return found;
  if (found.value.length === 0) {
    return err({ kind: "invalid_response", message: `YouTube returned no long-form result for "${query}"`, retryable: false });
  }

  const candidate = found.value[0];
  const video: SourcedVideo = { ...candidate, query, url: `https://www.youtube.com/watch?v=${candidate.videoId}` };

  // The 24h cache (operator direction: a walkthrough is not re-pulled
  // hourly). A miss downloads into the cache slot, so the next render
  // reuses it; the clips cut from it never go there.
  //
  // The cache is consulted BEFORE the budget, and the budget counts real
  // downloads rather than queries. A cache hit costs nothing — no
  // bandwidth, no converter round trip, no minutes — so spending a
  // download slot on one would refuse footage the machine already has.
  let sourcePath = await findCachedSource(deps.repoDir, video.videoId);
  let downloaded = false;

  if (sourcePath === null) {
    if (downloadBudget <= 0) {
      return err({
        kind: "policy_violation",
        message: `over the ${MAX_YOUTUBE_DOWNLOADS}-download ceiling for one render and "${query}" is not cached — falling back to stock`,
        retryable: false,
      });
    }
    for (const shot of group) await mark(deps, shot, "downloading");
    const fetched = await deps.download.fetchVideo({ url: video.url, maxDurationS: 4 * 60 * 60 });
    if (!fetched.ok) return fetched;
    const slot = await reserveCacheSlot(deps.repoDir, video.videoId);
    // `rename` across devices throws; the copy is the portable path and the
    // file is at most a couple of gigabytes on a local disk.
    await rename(fetched.value.filePath, slot).catch(async () => {
      await copyFile(fetched.value.filePath, slot);
    });
    sourcePath = slot;
    downloaded = true;
  }

  const probed = await probeVideo(sourcePath);
  if (!probed.ok) return probed;

  // The buffer, first, so nothing downstream can reach an intro or an outro.
  const trimmedPath = join(deps.workDir, `yt-${video.videoId}-body.mp4`);
  const trimmed = await trimHeadTail(sourcePath, probed.value.durationS, HEAD_TAIL_BUFFER_S, trimmedPath);
  if (!trimmed.ok) return trimmed;

  const series = await computeMotionSeries(trimmed.value.filePath);
  if (!series.ok) return series;

  const ranked = findTopMotionWindows(series.value, WINDOW_S, MOTION_SHORTLIST);
  if (ranked.length === 0) {
    return err({ kind: "invalid_response", message: `no scorable window in ${video.videoId} after the head/tail buffer`, retryable: false });
  }

  const windows = viral
    ? sampleMotionWindows(ranked, group.length, MOTION_SHORTLIST, deps.random ?? Math.random)
    : ranked.slice(0, group.length);
  if (windows.length === 0) {
    return err({ kind: "invalid_response", message: `no window available for "${query}"`, retryable: false });
  }

  const channelSourceId = `${YOUTUBE_SOURCE_ID_PREFIX}-${video.videoId}`;
  await ensureSource(deps.db, {
    id: channelSourceId,
    channelUrl: video.url,
    // `game` is the gameplay library's axis. Prefixed so a stale
    // `focusGames` directive can never name it and so it cannot collide
    // with a real game in `pickGamesForToday`.
    game: viral ? "sourced:gta6" : "sourced:youtube",
    licenseNote: `Sourced from YouTube for one render and not retained. Video ${video.videoId} — ${video.title}. ${video.url}`,
    kind: "stock",
    enabled: 1,
  });

  const out: SourcedShot[] = [];
  for (let i = 0; i < group.length && i < windows.length; i++) {
    const shot = group[i];
    const window = windows[i];
    // Offsets are reported against the ORIGINAL video, not the trimmed
    // body: a reviewer checking provenance opens the source, and the
    // buffer is our bookkeeping, not theirs.
    const startS = Math.round(trimmed.value.keptFromS + window.startS);
    const clipPath = join(deps.workDir, `yt-${video.videoId}-${startS}.mp4`);

    const cut = await extractClip(trimmed.value.filePath, window.startS, WINDOW_S, clipPath);
    if (!cut.ok) {
      // The next window is tried; a failure here costs one shot, not the
      // render. Recorded rather than skipped silently.
      await mark(deps, shot, "failed", { error: `${cut.error.kind}: ${cut.error.message}` });
      continue;
    }

    const segmentId = `yt-${video.videoId}-${startS}`;
    await registerSegment(deps.db, {
      segmentId,
      footageSourceId: channelSourceId,
      sourceVideoId: video.videoId,
      clipStartS: startS,
      clipEndS: startS + WINDOW_S,
      motionScore: window.score,
      locator: video.url,
      provider: "youtube",
      providerClipId: video.videoId,
      photographer: null,
      pageUrl: video.url,
      searchQuery: query,
      nowIso: deps.nowIso,
    });
    await mark(deps, shot, "clipped", { footageSegmentId: segmentId });

    out.push({
      position: shot.position,
      planPosition: shot.position,
      beatIndex: shot.beatIndex,
      intent: shot.intent,
      query,
      source: "youtube",
      segmentId,
      filePath: clipPath,
      durationS: WINDOW_S,
      provider: "youtube",
      providerClipId: video.videoId,
      photographer: null,
      pageUrl: video.url,
    });
  }

  if (out.length === 0) return err({ kind: "provider_error", message: `every window of ${video.videoId} failed to cut`, retryable: true });
  return ok({ shots: out, downloaded });
}

/** One Pexels clip for one shot, skipping any clip already used elsewhere in this montage. */
async function sourceFromPexels(
  shot: PlannedShot,
  deps: SourceDeps,
  already: Map<number, SourcedShot>,
): Promise<Result<SourcedShot, DriverError>> {
  await ensureSource(deps.db, {
    id: PEXELS_SOURCE_ID,
    channelUrl: "https://www.pexels.com/videos/",
    game: "stock:pexels",
    licenseNote: "Pexels License — free to use, modification permitted, no attribution required (attribution recorded per clip regardless). https://www.pexels.com/license/",
    kind: "stock",
    enabled: 1,
  });

  await mark(deps, shot, "searching");

  const search = await deps.pexels.searchVideos(shot.query, { perPage: 5, orientation: "portrait", minWidth: 1080 });
  if (!search.ok) return search;

  const usedIds = new Set([...already.values()].map((s) => s.providerClipId));
  const candidates = await rankByUse(deps.db, search.value.filter((clip) => !usedIds.has(String(clip.id))));
  if (candidates.length === 0) {
    return err({ kind: "invalid_response", message: `no unused portrait clip on Pexels for "${shot.query}"`, retryable: false });
  }

  let lastError: DriverError = { kind: "provider_error", message: "no candidate attempted", retryable: false };
  await mark(deps, shot, "downloading");

  for (const clip of candidates) {
    const downloaded = await deps.pexels.downloadClip(clip.videoUrl);
    if (!downloaded.ok) {
      lastError = downloaded.error;
      continue;
    }

    const filePath = join(deps.workDir, `pexels-${shot.position}-${clip.id}.mp4`);
    await writeFile(filePath, downloaded.value);

    const probe = await probeVideo(filePath);
    if (!probe.ok) {
      lastError = probe.error;
      continue;
    }

    const segmentId = `pexels-${clip.id}`;
    await registerSegment(deps.db, {
      segmentId,
      footageSourceId: PEXELS_SOURCE_ID,
      sourceVideoId: String(clip.id),
      clipStartS: 0,
      clipEndS: Math.max(1, Math.ceil(probe.value.durationS)),
      // Not measured. A 12-second stock clip has no uninteresting part to
      // skip — motion scoring exists to find the interesting minute inside
      // an hour of walkthrough. 0 means "no motion analysis was run", which
      // is true of every Pexels row and of no YouTube one.
      motionScore: 0,
      locator: clip.videoUrl,
      provider: "pexels",
      providerClipId: String(clip.id),
      photographer: clip.photographer,
      pageUrl: clip.sourceUrl,
      searchQuery: shot.query,
      nowIso: deps.nowIso,
    });
    await mark(deps, shot, "clipped", { footageSegmentId: segmentId });

    return ok({
      position: shot.position,
      planPosition: shot.position,
      beatIndex: shot.beatIndex,
      intent: shot.intent,
      query: shot.query,
      source: "pexels",
      segmentId,
      filePath,
      durationS: probe.value.durationS,
      provider: "pexels",
      providerClipId: String(clip.id),
      photographer: clip.photographer,
      pageUrl: clip.sourceUrl,
    });
  }

  return err(lastError);
}

/**
 * Least-used first.
 *
 * Two runs on the same topic would otherwise both take Pexels' first result
 * and ship the same shot twice. Rows for clips whose video has since expired
 * are gone (db/exports-reap.ts), which correctly makes those clips fresh
 * again — nothing is being shown twice inside any window the operator can
 * still see.
 */
async function rankByUse(db: AppDb, clips: PexelsClip[]): Promise<PexelsClip[]> {
  if (clips.length === 0) return [];
  const ids = clips.map((clip) => `pexels-${clip.id}`);
  const known = await db.select().from(footageSegments).where(inArray(footageSegments.id, ids)).all();
  const usedById = new Map(known.map((row) => [row.id, row.usedCount]));
  return [...clips].sort((a, b) => (usedById.get(`pexels-${a.id}`) ?? 0) - (usedById.get(`pexels-${b.id}`) ?? 0));
}

/** The provenance row, written before the clip reaches the encoder. Inserted once per clip and thereafter only rotated. */
async function registerSegment(
  db: AppDb,
  input: {
    segmentId: string;
    footageSourceId: string;
    sourceVideoId: string;
    clipStartS: number;
    clipEndS: number;
    motionScore: number;
    /** Where the bytes came from — a provider URL. Never a path: nothing is stored. */
    locator: string;
    provider: string;
    providerClipId: string;
    photographer: string | null;
    pageUrl: string;
    searchQuery: string;
    nowIso: string;
  },
): Promise<void> {
  const existing = await getOne(db.select().from(footageSegments).where(eq(footageSegments.id, input.segmentId)));
  if (existing) {
    await db
      .update(footageSegments)
      .set({ usedCount: existing.usedCount + 1, lastUsedAt: input.nowIso, searchQuery: input.searchQuery })
      .where(eq(footageSegments.id, input.segmentId))
      .run();
    return;
  }

  await db
    .insert(footageSegments)
    .values({
      id: input.segmentId,
      footageSourceId: input.footageSourceId,
      sourceVideoId: input.sourceVideoId,
      clipStartS: input.clipStartS,
      clipEndS: input.clipEndS,
      motionScore: input.motionScore,
      libraryPath: input.locator,
      provider: input.provider,
      providerClipId: input.providerClipId,
      photographer: input.photographer,
      pageUrl: input.pageUrl,
      searchQuery: input.searchQuery,
      usedCount: 1,
      lastUsedAt: input.nowIso,
      fetchedAt: input.nowIso,
    })
    .run();
}
