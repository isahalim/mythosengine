import type { AppDb } from "../../../db/client.ts";
import type { KvLike } from "../../lib/drivers/cache-kv.ts";
import { createPexelsDriverFromVault, type PexelsClip, type PexelsDriver } from "../../lib/drivers/pexels.ts";
import type { VaultKv } from "../../lib/vault.ts";
import { getRunProgress } from "./runs.ts";

/**
 * The waiting screen's montage (plan v2 §7): while a run works, each video's
 * card cycles stock clips pulled from Pexels for the keywords of the script
 * that run is writing, so the operator watches the film assemble itself
 * conceptually instead of watching a spinner.
 *
 * **These are previews, not footage.** The rendered video's footage comes
 * from the maintained, provenance-tracked library and from nowhere else
 * (CLAUDE.md). Nothing in this file writes to `footage_segments`, and the
 * clips it returns are labelled as previews in the UI and carry their
 * Pexels attribution. The operator asked for the montage on exactly those
 * terms: relevant clips, shown while waiting, whether or not they end up in
 * the video.
 */

/** One preview clip, with the keyword that retrieved it — the UI captions the card with it. */
interface MontageClip extends PexelsClip {
  keyword: string;
}

interface MontageVideo {
  scriptId: string;
  keywords: string[];
  clips: MontageClip[];
}

export interface RunMontage {
  traceId: string;
  /** False when no PEXELS_API_KEY is in the vault or the Worker env. The UI says so rather than showing an empty montage that reads as a failure. */
  configured: boolean;
  videos: MontageVideo[];
  /** Keywords whose search failed, with the driver's own error text. Surfaced, never swallowed. */
  failures: { keyword: string; error: string }[];
}

/** Keywords per video. Four is what the card can cycle through before the run outpaces it, and it bounds the Pexels spend per video per cache window. */
const KEYWORDS_PER_VIDEO = 4;
/** Clips per keyword. Two gives the cycle some variety without doubling the request cost — a Pexels page is one request regardless. */
const CLIPS_PER_KEYWORD = 2;
/**
 * A keyword's clips are cached for a day. Stock results for "surveillance
 * camera" do not change hour to hour, and Pexels' free tier is 200
 * requests/hour — a run of six videos would otherwise spend 24 of them on
 * every poll of the waiting screen.
 */
const CACHE_TTL_SECONDS = 24 * 60 * 60;
const CACHE_PREFIX = "montage:pexels:v1:";

function cacheKey(keyword: string): string {
  return `${CACHE_PREFIX}${keyword}`;
}

async function clipsForKeyword(
  driver: PexelsDriver,
  hotKv: KvLike,
  keyword: string,
): Promise<{ clips: MontageClip[]; failure: string | null }> {
  const cached = await hotKv.get(cacheKey(keyword));
  if (cached !== null) {
    try {
      const parsed = JSON.parse(cached) as PexelsClip[];
      if (Array.isArray(parsed)) return { clips: parsed.map((clip) => ({ ...clip, keyword })), failure: null };
    } catch {
      // A corrupt cache entry is a cache miss, not an error to report: the
      // search below overwrites it. Nothing is swallowed — the fresh result
      // is what the caller gets either way.
    }
  }

  const result = await driver.searchVideos(keyword, { perPage: CLIPS_PER_KEYWORD });
  if (!result.ok) return { clips: [], failure: `${result.error.kind}: ${result.error.message}` };

  await hotKv.put(cacheKey(keyword), JSON.stringify(result.value), { expirationTtl: CACHE_TTL_SECONDS });
  return { clips: result.value.map((clip) => ({ ...clip, keyword })), failure: null };
}

/**
 * `GET /console/runs/:traceId/montage`. Separate from `getRunProgress`
 * because the two have opposite cadences: progress is polled every few
 * seconds for as long as the run lasts, and this reaches an external API.
 * Folding them together would put a Pexels round trip behind every poll.
 */
export async function getRunMontage(
  db: AppDb,
  hotKv: KvLike,
  vaultKv: VaultKv,
  vaultMasterKey: string,
  envFallbackApiKey: string | undefined,
  traceId: string,
): Promise<RunMontage | null> {
  const progress = await getRunProgress(db, traceId);
  if (progress === null) return null;

  const driver = await createPexelsDriverFromVault(vaultKv, vaultMasterKey, envFallbackApiKey);
  if (driver === null) return { traceId, configured: false, videos: [], failures: [] };

  const failures: { keyword: string; error: string }[] = [];
  const videos: MontageVideo[] = [];

  // Keyword lookups are deduplicated across the run's videos: two videos on
  // the same topic share keywords, and the cache is per keyword, not per
  // video.
  const clipsByKeyword = new Map<string, MontageClip[]>();

  for (const video of progress.videos) {
    const keywords = video.keywords.slice(0, KEYWORDS_PER_VIDEO);
    const clips: MontageClip[] = [];

    for (const keyword of keywords) {
      const already = clipsByKeyword.get(keyword);
      if (already) {
        clips.push(...already);
        continue;
      }
      const { clips: fetched, failure } = await clipsForKeyword(driver, hotKv, keyword);
      clipsByKeyword.set(keyword, fetched);
      clips.push(...fetched);
      if (failure !== null) failures.push({ keyword, error: failure });
    }

    videos.push({ scriptId: video.scriptId, keywords, clips });
  }

  return { traceId, configured: true, videos, failures };
}

/**
 * One export's preview stills, keyed by export id.
 *
 * Stage 6 (docs/SIX_STAGES.md) asks the same question of Pexels that the
 * forge does — "what is this video about?" — but for work that has already
 * finished, so it cannot go through `getRunMontage`: an export outlives the
 * run that made it, and the operator reaches past work without a trace id
 * in hand.
 *
 * Same cache, same keys, same clips as the live montage
 * (`clipsForKeyword`), so a video the operator watched being forged shows
 * the identical stills when they come back to it, and costs no extra Pexels
 * request to do so.
 */
interface ExportPreview {
  exportId: string;
  keywords: string[];
  clips: MontageClip[];
}

export interface ExportPreviews {
  configured: boolean;
  exports: ExportPreview[];
  failures: { keyword: string; error: string }[];
}

/**
 * `GET /console/exports/previews`.
 *
 * `entries` is what the caller already listed — this deliberately does not
 * re-read the export table, so the previews cannot describe a different set
 * of exports than the ones on screen.
 *
 * **Previews, not footage**, exactly as above: nothing here writes to
 * `footage_segments` and the stage that renders these keeps saying so
 * (CLAUDE.md's footage constraint is about what reaches a render, and this
 * never does).
 */
export async function getExportPreviews(
  hotKv: KvLike,
  vaultKv: VaultKv,
  vaultMasterKey: string,
  envFallbackApiKey: string | undefined,
  entries: { id: string; keywords: string[] }[],
): Promise<ExportPreviews> {
  const driver = await createPexelsDriverFromVault(vaultKv, vaultMasterKey, envFallbackApiKey);
  if (driver === null) return { configured: false, exports: [], failures: [] };

  const failures: { keyword: string; error: string }[] = [];
  const previews: ExportPreview[] = [];
  const clipsByKeyword = new Map<string, MontageClip[]>();

  for (const entry of entries) {
    const keywords = entry.keywords.slice(0, KEYWORDS_PER_VIDEO);
    const clips: MontageClip[] = [];

    for (const keyword of keywords) {
      const already = clipsByKeyword.get(keyword);
      if (already) {
        clips.push(...already);
        continue;
      }
      const { clips: fetched, failure } = await clipsForKeyword(driver, hotKv, keyword);
      clipsByKeyword.set(keyword, fetched);
      clips.push(...fetched);
      if (failure !== null) failures.push({ keyword, error: failure });
    }

    previews.push({ exportId: entry.id, keywords, clips });
  }

  return { configured: true, exports: previews, failures };
}
