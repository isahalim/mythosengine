import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { fetchWithRetry } from "./http.ts";
import type { DriverError, UploadDriver, UploadRequest, UploadResponse } from "./types.ts";
import { err, ok, type Result } from "../result.ts";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status";

interface TokenResponse {
  access_token?: string;
}

interface VideoResource {
  id?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export interface YoutubeUploadDriverOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  tokenUrl?: string;
  uploadUrl?: string;
}

/**
 * YouTube Data API v3, OAuth (refresh-token flow, vault-managed — see
 * CONSOLE_SPEC.md §2). Uses the resumable upload protocol: initiate a
 * session with metadata, then PUT the file bytes in one shot (our files are
 * small — a 60s 1080x1920 h264 Short, not a multi-GB upload — so full
 * chunk-by-chunk resume logic isn't worth the complexity yet).
 */
export class YoutubeUploadDriver implements UploadDriver {
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly tokenUrl: string;
  private readonly uploadUrl: string;

  constructor(private readonly options: YoutubeUploadDriverOptions) {
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 500;
    this.tokenUrl = options.tokenUrl ?? TOKEN_URL;
    this.uploadUrl = options.uploadUrl ?? UPLOAD_URL;
  }

  async publish(req: UploadRequest): Promise<Result<UploadResponse, DriverError>> {
    const tokenResult = await this.getAccessToken();
    if (!tokenResult.ok) return tokenResult;
    const accessToken = tokenResult.value;

    const fileStat = await stat(req.filePath);

    const sessionResult = await fetchWithRetry(
      this.uploadUrl,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json; charset=UTF-8",
          "x-upload-content-type": "video/mp4",
          "x-upload-content-length": String(fileStat.size),
        },
        body: JSON.stringify({
          snippet: {
            title: req.title,
            description: req.description,
            tags: req.tags,
            categoryId: req.categoryId ?? "20", // Gaming
          },
          status: {
            privacyStatus: req.privacyStatus ?? "public",
            containsSyntheticMedia: req.containsSyntheticMedia,
          },
        }),
      },
      { timeoutMs: this.timeoutMs, maxAttempts: this.maxAttempts, baseDelayMs: this.baseDelayMs, fetchImpl: this.options.fetchImpl },
    );
    if (!sessionResult.ok) return sessionResult;

    const uploadSessionUrl = sessionResult.value.headers.get("location");
    if (!uploadSessionUrl) {
      return err({
        kind: "invalid_response",
        message: "YouTube resumable-upload initiation returned no Location header",
        retryable: false,
      });
    }

    // Node's fetch accepts a ReadableStream body for streaming uploads
    // without buffering the whole file in memory first, but that requires
    // `duplex: "half"` -- a Node/undici extension not present in the DOM
    // lib's RequestInit type. Building a typed variable (not a fresh object
    // literal at the call site) avoids TypeScript's excess-property check
    // without suppressing anything.
    const { Readable } = await import("node:stream");
    const body = Readable.toWeb(createReadStream(req.filePath)) as ReadableStream;
    const putInit: RequestInit & { duplex: "half" } = {
      method: "PUT",
      headers: { "content-type": "video/mp4", "content-length": String(fileStat.size) },
      body,
      duplex: "half",
    };

    const putResult = await fetchWithRetry(uploadSessionUrl, putInit, {
      timeoutMs: this.timeoutMs,
      maxAttempts: this.maxAttempts,
      baseDelayMs: this.baseDelayMs,
      fetchImpl: this.options.fetchImpl,
    });
    if (!putResult.ok) return putResult;

    let parsed: unknown;
    try {
      parsed = await putResult.value.json();
    } catch (cause) {
      return err({
        kind: "invalid_response",
        message: `malformed JSON from YouTube after upload: ${cause instanceof Error ? cause.message : String(cause)}`,
        retryable: false,
      });
    }

    if (!isVideoResource(parsed) || typeof parsed.id !== "string") {
      return err({ kind: "invalid_response", message: "YouTube upload response had no video id", retryable: false });
    }

    return ok({ videoId: parsed.id, url: `https://youtube.com/shorts/${parsed.id}` });
  }

  private async getAccessToken(): Promise<Result<string, DriverError>> {
    const result = await fetchWithRetry(
      this.tokenUrl,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.options.clientId,
          client_secret: this.options.clientSecret,
          refresh_token: this.options.refreshToken,
          grant_type: "refresh_token",
        }).toString(),
      },
      { timeoutMs: this.timeoutMs, maxAttempts: this.maxAttempts, baseDelayMs: this.baseDelayMs, fetchImpl: this.options.fetchImpl },
    );
    if (!result.ok) return result;

    let parsed: unknown;
    try {
      parsed = await result.value.json();
    } catch (cause) {
      return err({
        kind: "invalid_response",
        message: `malformed JSON from Google's token endpoint: ${cause instanceof Error ? cause.message : String(cause)}`,
        retryable: false,
      });
    }

    if (!isTokenResponse(parsed) || typeof parsed.access_token !== "string") {
      return err({
        kind: "invalid_response",
        message: "token refresh response had no access_token — refresh token may be revoked",
        retryable: false,
      });
    }

    return ok(parsed.access_token);
  }
}

function isTokenResponse(value: unknown): value is TokenResponse {
  return isObject(value);
}

function isVideoResource(value: unknown): value is VideoResource {
  return isObject(value);
}
