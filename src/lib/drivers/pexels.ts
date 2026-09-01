import { fetchWithRetry } from "./http.ts";
import type { DriverError } from "./types.ts";
import { err, ok, type Result } from "../result.ts";
import { Vault, type VaultKv } from "../vault.ts";

/**
 * Pexels stock video search, and the fetch that pulls one clip's bytes.
 *
 * Two callers, and the difference between them is worth stating because it
 * used to be the whole point of this file:
 *
 * - **The console's preview montage** (`src/server/console/montage.ts`)
 *   shows the operator stills while a run works. Nothing about that path
 *   reaches a render.
 * - **Stock footage** (`src/lib/footage/stock.ts`, operator direction
 *   2026-09-01) does reach the render. CLAUDE.md's "never use footage
 *   outside the maintained, provenance-tracked library" is a constraint on
 *   *provenance*, not on genre, so those clips are registered in
 *   `footage_sources`/`footage_segments` with their licence, photographer,
 *   clip page and the keyword that retrieved them before a single frame is
 *   encoded — the same audit trail a gameplay clip carries, and the export
 *   names every one of them.
 *
 * Same shape as every other driver in this directory: `Result<T,
 * DriverError>`, `fetchWithRetry`, no throw across the boundary.
 */

const API_BASE = "https://api.pexels.com/videos/search";
const DEFAULT_TIMEOUT_MS = 8_000;
/** A search is a JSON round trip; a clip is tens of megabytes over a home connection. */
const DOWNLOAD_TIMEOUT_MS = 120_000;
/** Per-clip ceiling. The rendition picker asks for the smallest sharp file; this refuses one that is somehow still enormous. */
const MAX_CLIP_BYTES = 120 * 1024 * 1024;

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
  /**
   * Smallest acceptable rendition width. The montage plays these in cards a
   * few hundred pixels wide and wants the cheapest sharp file; RENDER crops
   * them to fill a 1080x1920 frame and wants at least that much detail, or
   * the montage is visibly softer than the gameplay footage beside it.
   */
  minWidth?: number;
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

function pickRendition(files: unknown, minWidth: number): { link: string; width: number; height: number } | null {
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

  return candidates.find((file) => file.width >= minWidth) ?? candidates[candidates.length - 1] ?? null;
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
    const minWidth = options.minWidth ?? this.options.minWidth ?? MIN_WIDTH;
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
      const rendition = pickRendition(video.video_files, minWidth);
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

  /**
   * One clip's bytes, for the render path.
   *
   * Separate from `searchVideos` and deliberately dumb: it takes a
   * `videoUrl` this driver itself produced, so there is no URL construction
   * and nothing to get wrong. A response that is not a video is rejected
   * here on its content type and again by `probeVideo` on the written file
   * (src/lib/footage/stock.ts) — a stock CDN serving an HTML error page with
   * a 200 is the exact failure that check exists for.
   *
   * `maxBytes` is a real ceiling, not a formality. A render pulls several of
   * these per video on the operator's own laptop over their own connection,
   * and Pexels' 4K masters run to hundreds of megabytes; the rendition
   * picker already asks for the smallest sharp file, and this refuses to
   * stream one that is somehow still enormous rather than filling a disk.
   */
  async downloadClip(videoUrl: string, options: { timeoutMs?: number; maxBytes?: number; fetchImpl?: typeof fetch } = {}): Promise<Result<Uint8Array<ArrayBuffer>, DriverError>> {
    const response = await fetchWithRetry(
      videoUrl,
      { method: "GET", headers: { authorization: this.apiKey } },
      {
        timeoutMs: options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS,
        maxAttempts: 2,
        baseDelayMs: 500,
        fetchImpl: options.fetchImpl ?? this.options.fetchImpl,
      },
    );
    if (!response.ok) return response;

    const contentType = response.value.headers.get("content-type") ?? "";
    if (contentType.length > 0 && !contentType.startsWith("video/")) {
      return err({ kind: "invalid_response", message: `Pexels served ${contentType} for a clip download, not a video`, retryable: false });
    }

    const maxBytes = options.maxBytes ?? MAX_CLIP_BYTES;
    const declared = Number(response.value.headers.get("content-length") ?? Number.NaN);
    if (Number.isFinite(declared) && declared > maxBytes) {
      return err({ kind: "invalid_response", message: `clip is ${declared} bytes, over the ${maxBytes}-byte ceiling`, retryable: false });
    }

    let buffer: ArrayBuffer;
    try {
      buffer = await response.value.arrayBuffer();
    } catch (cause) {
      return err({ kind: "provider_error", message: `Pexels clip download failed mid-transfer: ${String(cause)}`, retryable: true });
    }

    // Checked again against the body actually received: `content-length` is
    // the server's claim, and a chunked response does not send one at all.
    if (buffer.byteLength > maxBytes) {
      return err({ kind: "invalid_response", message: `clip body was ${buffer.byteLength} bytes, over the ${maxBytes}-byte ceiling`, retryable: false });
    }
    if (buffer.byteLength === 0) {
      return err({ kind: "invalid_response", message: "Pexels returned an empty clip body", retryable: true });
    }

    return ok(new Uint8Array(buffer));
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
