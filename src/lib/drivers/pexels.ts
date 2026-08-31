import { fetchWithRetry } from "./http.ts";
import type { DriverError } from "./types.ts";
import { err, ok, type Result } from "../result.ts";
import { Vault, type VaultKv } from "../vault.ts";

/**
 * Pexels stock video search — the console's *preview* footage source (plan
 * v2 §7's waiting screen, and §5's News + Pexels drivers ahead of it).
 *
 * What this is for, precisely, because the distinction is load-bearing: the
 * clips this returns are shown to the operator while a run works, chosen
 * from the keywords of the script the run is writing. They are **not** the
 * footage that ends up in the video. Nothing here writes to
 * `footage_segments`, and nothing here can be selected by FOOTAGE SELECT —
 * CLAUDE.md's "never use footage outside the maintained,
 * provenance-tracked library" is a constraint on what gets rendered, and
 * this never reaches a render. The UI labels every clip as a preview and
 * carries its Pexels attribution, so a reviewer cannot mistake one for
 * library footage.
 *
 * Same shape as every other driver in this directory: `Result<T,
 * DriverError>`, `fetchWithRetry`, no throw across the boundary.
 */

const API_BASE = "https://api.pexels.com/videos/search";
const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * Pexels' documented ceiling is 200 requests/hour, 20,000/month on the free
 * tier. The console caches per keyword (src/server/console/montage.ts), so
 * a run costs at most one request per distinct keyword per cache window —
 * but a driver that can be called in a loop still asks for few results per
 * call rather than many.
 */
const DEFAULT_PER_PAGE = 3;
const MAX_PER_PAGE = 15;

/** What the montage renders: one loopable clip plus the attribution Pexels' terms require. */
export interface PexelsClip {
  id: number;
  /** Direct mp4 link, smallest file that is still ≥640px wide — this plays in a card, not full-bleed. */
  videoUrl: string;
  /** Still frame, used as the <video> poster and as the whole visual under prefers-reduced-motion. */
  thumbnailUrl: string;
  durationS: number;
  width: number;
  height: number;
  photographer: string;
  /** The clip's page on pexels.com — the attribution link. */
  sourceUrl: string;
}

export interface PexelsSearchOptions {
  perPage?: number;
  orientation?: "landscape" | "portrait" | "square";
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** The fields of Pexels' response this driver reads. Everything else in the payload is ignored. */
interface PexelsApiVideoFile {
  link?: unknown;
  file_type?: unknown;
  width?: unknown;
  height?: unknown;
}

interface PexelsApiVideo {
  id?: unknown;
  url?: unknown;
  image?: unknown;
  duration?: unknown;
  width?: unknown;
  height?: unknown;
  user?: { name?: unknown } | null;
  video_files?: unknown;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Picks the smallest mp4 rendition at least `MIN_WIDTH` wide.
 *
 * Pexels returns every rendition of a clip, from a 240p preview to the
 * original 4K master, and the montage plays several at once in cards a few
 * hundred pixels wide. Taking `video_files[0]` — which is what the obvious
 * implementation does — can pull a 40 MB 4K file into the console for a
 * thumbnail-sized card. Smallest-that-is-still-sharp is the correct read.
 */
const MIN_WIDTH = 640;

function pickRendition(files: unknown): { link: string; width: number; height: number } | null {
  if (!Array.isArray(files)) return null;

  const candidates = files
    .map((raw): { link: string; width: number; height: number } | null => {
      const file = raw as PexelsApiVideoFile;
      const link = asString(file.link);
      const width = asNumber(file.width);
      const height = asNumber(file.height);
      if (link === null || width === null || height === null) return null;
      if (asString(file.file_type) !== "video/mp4") return null;
      return { link, width, height };
    })
    .filter((file): file is { link: string; width: number; height: number } => file !== null)
    .sort((a, b) => a.width - b.width);

  return candidates.find((file) => file.width >= MIN_WIDTH) ?? candidates[candidates.length - 1] ?? null;
}

export class PexelsDriver {
  constructor(
    private readonly apiKey: string,
    private readonly options: PexelsSearchOptions = {},
  ) {}

  async searchVideos(query: string, options: PexelsSearchOptions = {}): Promise<Result<PexelsClip[], DriverError>> {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      return err({ kind: "policy_violation", message: "refusing to search Pexels for an empty query", retryable: false });
    }

    const perPage = Math.min(options.perPage ?? this.options.perPage ?? DEFAULT_PER_PAGE, MAX_PER_PAGE);
    const orientation = options.orientation ?? this.options.orientation ?? "portrait";
    const url = `${API_BASE}?query=${encodeURIComponent(trimmed)}&per_page=${perPage}&orientation=${orientation}`;

    const response = await fetchWithRetry(
      url,
      { method: "GET", headers: { authorization: this.apiKey, accept: "application/json" } },
      {
        timeoutMs: options.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxAttempts: 2,
        baseDelayMs: 300,
        fetchImpl: options.fetchImpl ?? this.options.fetchImpl,
      },
    );
    if (!response.ok) return response;

    let payload: unknown;
    try {
      payload = await response.value.json();
    } catch (cause) {
      return err({ kind: "invalid_response", message: `Pexels returned non-JSON: ${String(cause)}`, retryable: false });
    }

    const videos = (payload as { videos?: unknown } | null)?.videos;
    if (!Array.isArray(videos)) {
      return err({ kind: "invalid_response", message: "Pexels response had no `videos` array", retryable: false });
    }

    // A clip missing any field the montage needs is dropped, not defaulted:
    // a card with no attribution or no playable file is worse than one clip
    // fewer, and CLAUDE.md forbids inventing the difference.
    const clips = videos.flatMap((raw): PexelsClip[] => {
      const video = raw as PexelsApiVideo;
      const id = asNumber(video.id);
      const sourceUrl = asString(video.url);
      const thumbnailUrl = asString(video.image);
      const photographer = asString(video.user?.name);
      const rendition = pickRendition(video.video_files);
      if (id === null || sourceUrl === null || thumbnailUrl === null || photographer === null || rendition === null) return [];

      return [
        {
          id,
          videoUrl: rendition.link,
          thumbnailUrl,
          durationS: asNumber(video.duration) ?? 0,
          width: rendition.width,
          height: rendition.height,
          photographer,
          sourceUrl,
        },
      ];
    });

    return ok(clips);
  }
}

/**
 * Vault-first, env-fallback key resolution — the same shape as
 * `createGroqDriverFromVault` (resolve-groq-driver.ts), and in
 * `src/lib/drivers/**` for the same reason: CLAUDE.md's NEVER block puts
 * every `vault.get()` call site in this directory.
 *
 * Returns null when no key is configured anywhere. That is a real, expected
 * state — Pexels is optional, the console renders "no Pexels key" honestly
 * rather than silently showing an empty montage that looks like a failure.
 */
export async function createPexelsDriverFromVault(
  vaultKv: VaultKv,
  masterKeyB64: string,
  envFallbackApiKey: string | undefined,
  options: PexelsSearchOptions = {},
): Promise<PexelsDriver | null> {
  const vault = new Vault(vaultKv, masterKeyB64);
  const entry = await vault.get("PEXELS_API_KEY");
  const apiKey = entry.ok && entry.value !== null ? entry.value.value : envFallbackApiKey;
  if (apiKey === undefined || apiKey.length === 0) return null;
  return new PexelsDriver(apiKey, options);
}
