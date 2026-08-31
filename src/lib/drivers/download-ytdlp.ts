import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describeError, probeVideo } from "./probe-video.ts";
import { extractYoutubeVideoId } from "./youtube-url.ts";
import type { DownloadDriver, DownloadRequest, DownloadResponse, DriverError } from "./types.ts";
import { err, ok, type Result } from "../result.ts";

const execFileAsync = promisify(execFile);

/**
 * Height ceiling, not an exact match. `render-ffmpeg.ts` scales a 16:9
 * source up to cover 1080x1920 and crops the centre, so a 1080p source
 * contributes a 608px-wide strip and a 720p source only 405px — quality here
 * is visible in the output, which is why the ceiling sits at 1080 and not
 * lower. Above 1080 buys nothing: the crop throws it away and the file grows.
 */
const DEFAULT_MAX_HEIGHT = 1080;

const METADATA_TIMEOUT_MS = 120_000;
const DOWNLOAD_TIMEOUT_MS = 1_800_000;

/**
 * Hard ceiling on what will be pulled onto the runner's disk, handed to
 * yt-dlp as `--max-filesize` so *it* aborts mid-transfer rather than this
 * process discovering the overrun afterwards. A GitHub-hosted runner has
 * ~14 GB free and a multi-hour walkthrough at 1080p is genuinely in this
 * range, so this is a real failure mode, not a theoretical one.
 */
const MAX_DOWNLOAD_BYTES = 6 * 1024 * 1024 * 1024;

/** stdout carries one path; stderr carries yt-dlp's diagnostics. Neither is large with `--no-progress`, but an unbounded pipe is still an unbounded pipe. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export interface YtDlpDownloadDriverOptions {
  /** Path to the pinned yt-dlp binary. Defaults to `yt-dlp` on PATH. */
  ytDlpBin?: string;
  ffprobeBin?: string;
  maxHeight?: number;
  metadataTimeoutMs?: number;
  downloadTimeoutMs?: number;
  maxDownloadBytes?: number;
  /**
   * yt-dlp deprecated YouTube extraction without a JavaScript runtime
   * (2026; see its EJS wiki) and warns that formats may be missing without
   * one. Only `deno` is enabled by default, and this project does not have
   * deno — but it does have Node 22 everywhere it runs, so Node is named
   * explicitly rather than left to a default that would silently degrade
   * which formats are offered.
   */
  jsRuntimes?: string;
  /**
   * Netscape-format cookie file, if the operator has chosen to supply one.
   *
   * Deliberately a path and never a value: a cookie jar is a credential, so
   * it arrives through the environment like every other secret in this
   * system (CLAUDE.md) and is never read, logged, or written by this driver.
   * Left unset, no cookies are sent at all — which is the intended state, and
   * the one every automated run is expected to work in.
   */
  cookiesFile?: string;
}

/**
 * Format selection, as one string, in explicit preference order:
 *
 *   1. H.264 video + m4a audio, muxed to mp4
 *   2. any codec at the height ceiling + best audio
 *   3. any single pre-muxed stream at the height ceiling
 *
 * H.264 is first on purpose. YouTube offers 1080p in AV1, VP9 and H.264, and
 * `[ext=mp4]` alone is *not* enough to get H.264 — AV1 is served in an mp4
 * container too, and measuring this live is how that was found: an
 * `[ext=mp4]` selector picked AV1 (format 399). AV1 decodes several times
 * slower than H.264 on the CPU-only runners this pipeline uses, and every
 * frame is decoded twice downstream (motion scoring, then clipping), so the
 * codec is a pipeline-speed decision and not a cosmetic one.
 *
 * The fallbacks exist because a video that offers no H.264 is worth taking in
 * VP9 rather than failing the whole refresh — slower is not the same as
 * unusable.
 */
function formatSelector(maxHeight: number): string {
  return [
    `bestvideo[height<=${maxHeight}][vcodec^=avc1]+bestaudio[ext=m4a]`,
    `bestvideo[height<=${maxHeight}]+bestaudio`,
    `best[height<=${maxHeight}]`,
  ].join("/");
}

/** What yt-dlp reports about a video before a byte is downloaded. Only the two fields this driver acts on are modelled; the rest of `--dump-json` is ignored on purpose. */
export interface YtDlpMetadata {
  durationS: number | null;
  title: string;
}

export function parseMetadata(stdout: string): Result<YtDlpMetadata, DriverError> {
  // `--dump-json` emits one JSON object per line, and a JS-runtime warning
  // can precede it on stdout in some yt-dlp builds, so the last non-empty
  // line is taken rather than the whole buffer.
  const line = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .pop();
  if (line === undefined) {
    return err({ kind: "invalid_response", message: "yt-dlp --dump-json produced no JSON object", retryable: false });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (cause) {
    return err({ kind: "invalid_response", message: `yt-dlp --dump-json produced unparseable JSON: ${describeError(cause)}`, retryable: false });
  }
  if (typeof parsed !== "object" || parsed === null) {
    return err({ kind: "invalid_response", message: "yt-dlp --dump-json produced something that isn't an object", retryable: false });
  }

  const record = parsed as { duration?: unknown; title?: unknown };
  // A live stream reports no duration at all. That is "the source didn't
  // say", never 0 — 0 would read as a legitimately empty video and sail
  // through the duration ceiling below.
  const duration = typeof record.duration === "number" && Number.isFinite(record.duration) && record.duration > 0 ? record.duration : null;
  return ok({ durationS: duration, title: typeof record.title === "string" ? record.title : "" });
}

/**
 * Turns yt-dlp's own words into a typed error, keeping those words.
 *
 * The keeping is the point. Three separate times this pipeline reported a
 * failure whose real cause was sitting in a message the code had discarded
 * (see the ytmp3 service-notice comment, and the Groq 4xx body fix of
 * 2026-08-31). yt-dlp is unusually good at saying exactly what went wrong, so
 * the classification below only ever *adds* a kind — it never replaces the
 * explanation.
 *
 * The bot-check case is called out by name because it is the specific,
 * expected failure for this system: YouTube serves it to datacenter IP
 * ranges, which is where GitHub-hosted runners live, and it is precisely
 * what the previous yt-dlp driver was deleted for losing to
 * (ARCHITECTURE.md §5.0). A run that dies this way must say so in one line,
 * because the fix is to move where the job runs and nothing else.
 */
export function classifyYtDlpError(stderr: string, cause: unknown): DriverError {
  const message = stderr.trim().length > 0 ? stderr.trim().slice(0, 600) : describeError(cause);
  const lower = message.toLowerCase();

  if (cause instanceof Error && cause.name === "AbortError") {
    return { kind: "timeout", message: `yt-dlp timed out: ${message}`, retryable: true };
  }
  if (lower.includes("enoent")) {
    return { kind: "provider_error", message: `${message} — is the pinned yt-dlp binary installed and executable?`, retryable: false };
  }
  // Age-gating is checked *before* the bot check and matched on its own
  // words. Both failures begin "Sign in to confirm", and a substring match
  // on that prefix reported an age-restricted video as an untrusted IP —
  // caught on the first live run, 2026-08-30. The two have opposite
  // remedies: an age gate means try another video, a bot check means the
  // whole runner is in the wrong place. Reporting one as the other would
  // send the operator to rebuild their CI over a single unusable candidate.
  if (lower.includes("confirm your age") || lower.includes("age-restricted") || lower.includes("inappropriate for some users")) {
    return { kind: "policy_violation", message: `this video is age-gated and cannot be downloaded anonymously: ${message}`, retryable: false };
  }
  if (lower.includes("not a bot")) {
    return {
      kind: "provider_error",
      message: `YouTube served its bot check instead of the video — this IP is not trusted for automated download: ${message}`,
      // Retrying from the same address gets the same answer; the fix is to
      // run from somewhere else, which no retry can accomplish.
      retryable: false,
    };
  }
  if (lower.includes("private video") || lower.includes("members-only") || lower.includes("video unavailable")) {
    return { kind: "policy_violation", message: `this video cannot be downloaded: ${message}`, retryable: false };
  }
  if (lower.includes("file is larger than max-filesize")) {
    return { kind: "policy_violation", message: `source exceeds the configured byte ceiling: ${message}`, retryable: false };
  }
  if (lower.includes("http error 429") || lower.includes("too many requests")) {
    return { kind: "rate_limited", message, retryable: true };
  }
  if (lower.includes("unable to download") || lower.includes("connection") || lower.includes("timed out") || lower.includes("temporary failure")) {
    return { kind: "network", message, retryable: true };
  }
  return { kind: "provider_error", message: `yt-dlp failed: ${message}`, retryable: true };
}

/**
 * Downloads one YouTube video with a pinned `yt-dlp` binary.
 *
 * Reinstates yt-dlp as an acquisition route (operator directive,
 * 2026-08-30) after `media.ytmp3.gg` began serving GitHub-hosted runners a
 * "Service Discontinued" modal over the converter form while serving a
 * working page to residential addresses. It does **not** delete
 * `download-ytmp3-dom.ts`: both satisfy `DownloadDriver`, the choice is made
 * at the one call site in `scripts/pipeline/footage-refresh.ts`, and having
 * two working routes is the entire reason this blockage is survivable.
 *
 * Why this is not a return to the setup deleted on 2026-08-28: that driver
 * was losing to YouTube's bot check and each commit was another patch at it.
 * Nothing here claims to have solved that — `classifyYtDlpError` names it as
 * its own failure kind precisely so the answer is one legible line rather
 * than a mystery, because the remedy is operational (where the job runs) and
 * not something a driver can fix.
 *
 * Two properties worth stating, both better than the converter route's:
 *
 *  - **Duration is checked before anything is downloaded.** `--dump-json`
 *    costs one cheap metadata call, so an over-long source is refused
 *    outright instead of after gigabytes have landed. ytmp3 could only do
 *    this advisorily, from an attribute on its own page.
 *  - **Nothing is trusted until probed.** yt-dlp reports the output path
 *    itself (`--print after_move:filepath`) rather than this code
 *    reconstructing it from a template, and that file is then validated by
 *    ffprobe — a real video stream and a finite duration — before
 *    `maxDurationS` is enforced against the *measured* duration.
 */
export class YtDlpDownloadDriver implements DownloadDriver {
  constructor(private readonly options: YtDlpDownloadDriverOptions = {}) {}

  private get bin(): string {
    return this.options.ytDlpBin ?? "yt-dlp";
  }

  /**
   * Flags every invocation carries.
   *
   * `--no-playlist` matters more than it looks: a walkthrough URL very often
   * carries a `list=` parameter, and without this yt-dlp would take the
   * whole playlist — which for this channel is a full multi-episode series.
   */
  private baseArgs(): string[] {
    const args = ["--no-playlist", "--no-progress", "--newline", "--js-runtimes", this.options.jsRuntimes ?? "node"];
    if (this.options.cookiesFile !== undefined) args.push("--cookies", this.options.cookiesFile);
    return args;
  }

  async fetchVideo(req: DownloadRequest): Promise<Result<DownloadResponse, DriverError>> {
    const sourceVideoId = extractYoutubeVideoId(req.url);
    if (sourceVideoId === null) {
      return err({ kind: "invalid_response", message: `not a recognizable YouTube watch URL: ${req.url}`, retryable: false });
    }

    const metadata = await this.readMetadata(req.url);
    if (!metadata.ok) return metadata;

    // The cheap refusal, before a byte moves. Advisory only in the sense
    // that it trusts yt-dlp's reported duration — the same ceiling is
    // enforced again below against ffprobe's own measurement of the file
    // that actually landed.
    const reported = metadata.value.durationS;
    if (req.maxDurationS !== undefined && reported !== null && reported > req.maxDurationS) {
      return err({
        kind: "policy_violation",
        message: `yt-dlp reports the source is ${Math.round(reported)}s, exceeds maxDurationS=${req.maxDurationS} — refusing before downloading it`,
        retryable: false,
      });
    }
    console.warn(`[yt-dlp] ${sourceVideoId}: "${metadata.value.title}", ${reported === null ? "unknown" : Math.round(reported)}s — starting download.`);

    const downloadsDir = await mkdtemp(join(tmpdir(), "ytdlp-"));
    const downloaded = await this.download(req.url, downloadsDir);
    if (!downloaded.ok) return downloaded;

    const probed = await probeVideo(downloaded.value, this.options.ffprobeBin);
    if (!probed.ok) return probed;
    const { durationS } = probed.value;

    if (req.maxDurationS !== undefined && durationS > req.maxDurationS) {
      return err({
        kind: "policy_violation",
        message: `downloaded video is ${durationS}s, exceeds maxDurationS=${req.maxDurationS} — refusing to use it`,
        retryable: false,
      });
    }

    console.warn(`[yt-dlp] ${sourceVideoId}: downloaded and validated, ${Math.round(durationS)}s.`);
    return ok({ filePath: downloaded.value, durationS, sourceVideoId });
  }

  /** `--dump-json` with `--simulate`: metadata only, nothing written, and the first place a bot check shows up — cheaply, before any transfer starts. */
  private async readMetadata(url: string): Promise<Result<YtDlpMetadata, DriverError>> {
    try {
      const { stdout } = await execFileAsync(this.bin, [...this.baseArgs(), "--simulate", "--dump-json", url], {
        signal: AbortSignal.timeout(this.options.metadataTimeoutMs ?? METADATA_TIMEOUT_MS),
        maxBuffer: MAX_OUTPUT_BYTES,
      });
      return parseMetadata(stdout);
    } catch (cause) {
      return err(classifyYtDlpError(stderrOf(cause), cause));
    }
  }

  /**
   * The download itself. yt-dlp is told the byte ceiling (`--max-filesize`)
   * so it aborts mid-transfer rather than this code discovering an overrun
   * after the disk is already full, and it is asked to print the path it
   * actually produced (`--print after_move:filepath`) rather than this code
   * reconstructing one from the `-o` template — merging and remuxing can
   * both change the extension, and guessing it is how a driver ends up
   * reporting "file not found" about a file that downloaded perfectly.
   */
  private async download(url: string, downloadsDir: string): Promise<Result<string, DriverError>> {
    const maxBytes = this.options.maxDownloadBytes ?? MAX_DOWNLOAD_BYTES;
    const args = [
      ...this.baseArgs(),
      "-f",
      formatSelector(this.options.maxHeight ?? DEFAULT_MAX_HEIGHT),
      "--merge-output-format",
      "mp4",
      "--max-filesize",
      String(maxBytes),
      "-o",
      join(downloadsDir, "%(id)s.%(ext)s"),
      "--print",
      "after_move:filepath",
      url,
    ];

    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(this.bin, args, {
        signal: AbortSignal.timeout(this.options.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS),
        maxBuffer: MAX_OUTPUT_BYTES,
      }));
    } catch (cause) {
      return err(classifyYtDlpError(stderrOf(cause), cause));
    }

    const filePath = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .pop();
    // yt-dlp exits 0 without printing a path when `--max-filesize` rejects
    // the video: the transfer is skipped, not failed. Without this the
    // driver would go on to probe `undefined` and report a confusing
    // ffprobe error for a limit that worked exactly as intended.
    if (filePath === undefined || !filePath.startsWith(downloadsDir)) {
      return err({
        kind: "policy_violation",
        message: `yt-dlp exited cleanly without writing a file — the source was skipped, most likely for exceeding the ${maxBytes}-byte ceiling`,
        retryable: false,
      });
    }
    return ok(filePath);
  }
}

/** execFile rejects with an Error carrying the child's stderr — that text is the diagnosis, so it must not be dropped on the way out. */
function stderrOf(cause: unknown): string {
  if (typeof cause === "object" && cause !== null && "stderr" in cause) {
    const { stderr } = cause as { stderr?: unknown };
    if (typeof stderr === "string") return stderr;
  }
  return "";
}
