import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DownloadDriver, DownloadRequest, DownloadResponse, DriverError } from "./types.ts";
import { err, ok, type Result } from "../result.ts";

const execFileAsync = promisify(execFile);

// YouTube's bot-detection challenge ("Sign in to confirm you're not a bot")
// hits yt-dlp hard from datacenter IPs like GitHub Actions runners
// (confirmed live, 2026-08-29 — every FOOTAGE REFRESH source failed on
// this). Requesting the tv/web_safari player clients is yt-dlp's
// documented, cookie-free mitigation, but confirmed live (same date) not
// to reliably clear the check on its own — kept only as the no-cookies
// fallback in authArgs() below, never combined with cookies (see there).
const NO_COOKIES_PLAYER_CLIENT_ARGS = "youtube:player_client=tv,web_safari";

// yt-dlp defaults to the tv_downgraded player client whenever cookies are
// present, which is currently broken for many users — "ERROR: The page
// needs to be reloaded." (confirmed live, 2026-08-29, every candidate of
// every source, right after cookie auth started working). Current
// maintainer guidance and a confirmed-working report from another user
// hitting the identical error: yt-dlp/yt-dlp#17389
// (https://github.com/yt-dlp/yt-dlp/issues/17389) — this is that fix, not
// a guess.
const COOKIES_PLAYER_CLIENT_ARGS = "youtube:player_client=default,web_embedded";

interface YtDlpMetadata {
  id?: string;
  duration?: number;
}

function isYtDlpMetadata(value: unknown): value is YtDlpMetadata {
  return typeof value === "object" && value !== null;
}

/**
 * yt-dlp, invoked as a pinned subprocess (never imported — same rationale as
 * every other CLI-shaped driver in this repo). Used ONLY by the weekly
 * FOOTAGE REFRESH job (ARCHITECTURE.md §5.0) — never inline in a daily
 * render. Fetches metadata first so an over-long candidate is refused
 * before any bytes move, not after.
 */
export interface YtDlpDownloadDriverOptions {
  ytDlpBin?: string; // defaults to "yt-dlp"; contract tests point this at a fixture script
  timeoutMs?: number;
  cookiesFile?: string; // path to a Netscape-format cookies file exported from a signed-in account; omit for the unauthenticated fallback
}

export class YtDlpDownloadDriver implements DownloadDriver {
  private readonly ytDlpBin: string;
  private readonly timeoutMs: number;
  private readonly cookiesFile: string | undefined;

  constructor(options: YtDlpDownloadDriverOptions = {}) {
    this.ytDlpBin = options.ytDlpBin ?? "yt-dlp";
    this.timeoutMs = options.timeoutMs ?? 120_000; // metadata + download can both be slow
    this.cookiesFile = options.cookiesFile;
  }

  // Cookies from a signed-in account are the fix that actually clears
  // YouTube's bot-check (confirmed against yt-dlp's own current maintainer
  // guidance, 2026-08-29 — PO tokens no longer reliably help), but need
  // their own player-client override (COOKIES_PLAYER_CLIENT_ARGS) — the
  // tv/web_safari combo used without cookies actively breaks once cookies
  // are added (see that constant's comment), so the two are never mixed.
  private authArgs(): string[] {
    return this.cookiesFile
      ? ["--cookies", this.cookiesFile, "--extractor-args", COOKIES_PLAYER_CLIENT_ARGS]
      : ["--extractor-args", NO_COOKIES_PLAYER_CLIENT_ARGS];
  }

  async fetchVideo(req: DownloadRequest): Promise<Result<DownloadResponse, DriverError>> {
    const metadataResult = await this.fetchMetadata(req.url);
    if (!metadataResult.ok) return metadataResult;
    const { id, duration } = metadataResult.value;

    if (req.maxDurationS !== undefined && duration > req.maxDurationS) {
      return err({
        kind: "policy_violation",
        message: `video ${id} is ${duration}s, exceeds maxDurationS=${req.maxDurationS} — refusing to download`,
        retryable: false,
      });
    }

    const dir = await mkdtemp(join(tmpdir(), "ytdlp-"));
    try {
      await execFileAsync(
        this.ytDlpBin,
        [
          "--no-playlist",
          "--no-warnings",
          ...this.authArgs(),
          "-f",
          "bestvideo[height<=1080]+bestaudio/best[height<=1080]",
          "--merge-output-format",
          "mp4",
          "-o",
          join(dir, "video.%(ext)s"),
          req.url,
        ],
        { signal: AbortSignal.timeout(this.timeoutMs) },
      );
    } catch (cause) {
      await rm(dir, { recursive: true, force: true });
      return err(classifyError(cause));
    }

    const files = await readdir(dir);
    const videoFile = files.find((f) => f.startsWith("video."));
    if (!videoFile) {
      await rm(dir, { recursive: true, force: true });
      return err({
        kind: "invalid_response",
        message: "yt-dlp exited cleanly but produced no output file",
        retryable: true,
      });
    }

    return ok({ filePath: join(dir, videoFile), durationS: duration, sourceVideoId: id });
  }

  private async fetchMetadata(url: string): Promise<Result<{ id: string; duration: number }, DriverError>> {
    let stdout: string;
    try {
      const result = await execFileAsync(
        this.ytDlpBin,
        ["--dump-json", "--no-warnings", "--skip-download", "--no-playlist", ...this.authArgs(), url],
        { signal: AbortSignal.timeout(this.timeoutMs) },
      );
      stdout = result.stdout;
    } catch (cause) {
      return err(classifyError(cause));
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch (cause) {
      return err({
        kind: "invalid_response",
        message: `malformed JSON from yt-dlp --dump-json: ${cause instanceof Error ? cause.message : String(cause)}`,
        retryable: false,
      });
    }

    if (!isYtDlpMetadata(parsed) || typeof parsed.id !== "string" || typeof parsed.duration !== "number") {
      return err({
        kind: "invalid_response",
        message: "yt-dlp metadata missing id/duration",
        retryable: false,
      });
    }

    return ok({ id: parsed.id, duration: parsed.duration });
  }
}

function classifyError(cause: unknown): DriverError {
  const message = cause instanceof Error ? cause.message : String(cause);
  const isAbort = cause instanceof Error && cause.name === "AbortError";
  if (isAbort) return { kind: "timeout", message, retryable: true };
  if (message.includes("ENOENT")) {
    return { kind: "provider_error", message: `${message} — is yt-dlp installed?`, retryable: false };
  }
  return { kind: "network", message, retryable: true };
}
