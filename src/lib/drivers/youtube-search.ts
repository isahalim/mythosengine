import { fetchWithRetry } from "./http.ts";
import { parseIso8601Duration } from "./iso8601-duration.ts";
import type { ChannelTopVideoRequest, ChannelTopVideoResponse, DriverError, YoutubeSearchDriver } from "./types.ts";
import { err, ok, type Result } from "../result.ts";

const API_BASE = "https://www.googleapis.com/youtube/v3";

interface ChannelsListResponse {
  items?: { id?: string }[];
}
interface SearchListResponse {
  items?: { id?: { videoId?: string } }[];
}
interface VideosListResponse {
  items?: { id?: string; snippet?: { title?: string }; contentDetails?: { duration?: string }; statistics?: { viewCount?: string } }[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export interface YoutubeSearchDriverOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  apiBase?: string;
  /** How many of the channel's top-viewed videos to fetch details for before finding one that meets minDurationS. */
  candidatePoolSize?: number;
}

/**
 * YouTube Data API v3, read-only API key (not the OAuth upload credential —
 * this is a separate, much lower-privilege key: `Account:youtube.readonly`
 * scope only, per CONSOLE_SPEC.md's key-vault split). Resolves a channel
 * handle, finds its highest-viewed videos, and returns the first one long
 * enough to be a real walkthrough rather than another Short.
 */
export class YoutubeDataApiSearchDriver implements YoutubeSearchDriver {
  private readonly apiBase: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly candidatePoolSize: number;

  constructor(private readonly options: YoutubeSearchDriverOptions) {
    this.apiBase = options.apiBase ?? API_BASE;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 500;
    this.candidatePoolSize = options.candidatePoolSize ?? 10;
  }

  async findTopLongFormVideos(req: ChannelTopVideoRequest): Promise<Result<ChannelTopVideoResponse[], DriverError>> {
    const channelIdResult = await this.resolveChannelId(req.channelHandle);
    if (!channelIdResult.ok) return channelIdResult;

    const candidateIdsResult = await this.searchTopVideoIds(channelIdResult.value);
    if (!candidateIdsResult.ok) return candidateIdsResult;
    if (candidateIdsResult.value.length === 0) return ok([]);

    const detailsResult = await this.getVideoDetails(candidateIdsResult.value);
    if (!detailsResult.ok) return detailsResult;

    // search.list's order=viewCount already sorts descending -- filter to
    // candidates that clear the duration bar (a Short might otherwise
    // outperform the long-form videos), then re-sort descending since
    // filtering can change relative order versus the raw API response.
    const ranked = detailsResult.value.filter((v) => v.durationS >= req.minDurationS).sort((a, b) => b.viewCount - a.viewCount);

    return ok(ranked);
  }

  private async getJson(url: string): Promise<Result<unknown, DriverError>> {
    const result = await fetchWithRetry(
      url,
      {},
      { timeoutMs: this.timeoutMs, maxAttempts: this.maxAttempts, baseDelayMs: this.baseDelayMs, fetchImpl: this.options.fetchImpl },
    );
    if (!result.ok) return result;
    try {
      return ok(await result.value.json());
    } catch (cause) {
      return err({
        kind: "invalid_response",
        message: `malformed JSON from YouTube Data API: ${cause instanceof Error ? cause.message : String(cause)}`,
        retryable: false,
      });
    }
  }

  private async resolveChannelId(handle: string): Promise<Result<string, DriverError>> {
    const url = `${this.apiBase}/channels?part=id&forHandle=${encodeURIComponent(handle)}&key=${encodeURIComponent(this.options.apiKey)}`;
    const result = await this.getJson(url);
    if (!result.ok) return result;

    const body = result.value;
    const id = isChannelsListResponse(body) ? body.items?.[0]?.id : undefined;
    if (typeof id !== "string") {
      return err({ kind: "invalid_response", message: `no channel found for handle "${handle}"`, retryable: false });
    }
    return ok(id);
  }

  private async searchTopVideoIds(channelId: string): Promise<Result<string[], DriverError>> {
    const url =
      `${this.apiBase}/search?part=snippet&channelId=${encodeURIComponent(channelId)}&order=viewCount` +
      `&type=video&maxResults=${this.candidatePoolSize}&key=${encodeURIComponent(this.options.apiKey)}`;
    const result = await this.getJson(url);
    if (!result.ok) return result;

    const body = result.value;
    if (!isSearchListResponse(body)) {
      return err({ kind: "invalid_response", message: "search.list response had no items array", retryable: false });
    }
    const ids = (body.items ?? []).map((i) => i.id?.videoId).filter((id): id is string => typeof id === "string");
    return ok(ids);
  }

  private async getVideoDetails(videoIds: string[]): Promise<Result<ChannelTopVideoResponse[], DriverError>> {
    const url =
      `${this.apiBase}/videos?part=contentDetails,statistics,snippet&id=${videoIds.map(encodeURIComponent).join(",")}` +
      `&key=${encodeURIComponent(this.options.apiKey)}`;
    const result = await this.getJson(url);
    if (!result.ok) return result;

    const body = result.value;
    if (!isVideosListResponse(body)) {
      return err({ kind: "invalid_response", message: "videos.list response had no items array", retryable: false });
    }

    const details: ChannelTopVideoResponse[] = [];
    for (const item of body.items ?? []) {
      const durationS = item.contentDetails?.duration ? parseIso8601Duration(item.contentDetails.duration) : null;
      if (typeof item.id !== "string" || durationS === null || !item.snippet?.title) continue;
      details.push({
        videoId: item.id,
        title: item.snippet.title,
        durationS,
        viewCount: Number(item.statistics?.viewCount ?? 0),
      });
    }
    return ok(details);
  }
}

function isChannelsListResponse(value: unknown): value is ChannelsListResponse {
  return isObject(value);
}
function isSearchListResponse(value: unknown): value is SearchListResponse {
  return isObject(value);
}
function isVideosListResponse(value: unknown): value is VideosListResponse {
  return isObject(value);
}
