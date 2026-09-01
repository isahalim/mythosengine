import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * A short-lived scratch cache for downloaded YouTube sources.
 *
 * Operator direction, 2026-09-01: no sourced footage survives a run — but a
 * viral video is cut from a full walkthrough, and pulling ~1.6 GB through a
 * converter site before every render is a cost the operator explicitly did
 * not want to pay hourly. So the *source* download lives here for a day and
 * consecutive runs reuse it; every clip derived from it is written into the
 * render's own work directory and dies with the run, and no clip and no
 * Pexels byte is ever written here.
 *
 * Not the footage library, and deliberately not shaped like one: no branch,
 * no database rows, no provenance. Provenance lives in
 * `footage_segments`/`render_footage_parts` for exactly as long as there is
 * a video to review (db/exports-reap.ts). This is a download cache, and the
 * only question it answers is "do I already have this file".
 *
 * Swept by age at the top of every render, so a machine that renders once a
 * week never carries last week's gigabytes.
 */

export const CACHE_DIR = ".footage-cache";
/** Operator's choice: a day. Long enough for a session of runs, short enough that nothing accumulates. */
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function cachePath(repoDir: string, videoId: string): string {
  // The id is validated by `extractYoutubeVideoId` before it ever reaches
  // here, but this path is built from it, so it is re-checked rather than
  // trusted: a `../` in a video id would write outside the cache.
  if (!/^[A-Za-z0-9_-]{5,20}$/.test(videoId)) {
    throw new Error(`refusing to build a cache path from an implausible video id: ${JSON.stringify(videoId)}`);
  }
  return join(repoDir, CACHE_DIR, `${videoId}.mp4`);
}

/** The cached file for a video, or null when it is absent or older than the window. */
export async function findCachedSource(repoDir: string, videoId: string, now: () => number = Date.now): Promise<string | null> {
  const path = cachePath(repoDir, videoId);
  try {
    const info = await stat(path);
    if (now() - info.mtimeMs > MAX_AGE_MS) return null;
    // A zero-byte file is a download that died mid-flight, not a cache hit.
    if (info.size === 0) return null;
    return path;
  } catch {
    // Not cached. The only outcome that matters is "no file to reuse", and
    // stat throws for every flavour of that — missing, unreadable,
    // not-a-file. Nothing is being swallowed: the caller downloads.
    return null;
  }
}

/** Where a freshly downloaded source should be put so the next run finds it. */
export async function reserveCacheSlot(repoDir: string, videoId: string): Promise<string> {
  await mkdir(join(repoDir, CACHE_DIR), { recursive: true });
  return cachePath(repoDir, videoId);
}

/**
 * Deletes everything past the window. Reports what it removed rather than
 * doing it silently — a run that quietly frees 4 GB should say so.
 */
export async function sweepSourceCache(repoDir: string, now: () => number = Date.now): Promise<{ removed: number; bytesFreed: number }> {
  const dir = join(repoDir, CACHE_DIR);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return { removed: 0, bytesFreed: 0 }; // no cache yet, which is the ordinary first run
  }

  let removed = 0;
  let bytesFreed = 0;
  for (const entry of entries) {
    const path = join(dir, entry);
    const info = await stat(path).catch(() => null);
    if (info === null || now() - info.mtimeMs <= MAX_AGE_MS) continue;
    await rm(path, { force: true });
    removed += 1;
    bytesFreed += info.size;
  }
  return { removed, bytesFreed };
}
