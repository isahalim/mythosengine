import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import type { Page } from "playwright";
import { launchBrowserSession } from "./browser-session.ts";
import { extractYoutubeVideoId } from "./youtube-url.ts";
import type { DownloadDriver, DownloadRequest, DownloadResponse, DriverError } from "./types.ts";
import { err, ok, type Result } from "../result.ts";

const execFileAsync = promisify(execFile);

const YTMP3_TOOL_URL = "https://media.ytmp3.gg/tools/youtube-to-mp4-converter/dbismy";

/**
 * ytmp3.gg's own default once MP4 is selected. Kept as the default here
 * because the render pipeline crops hard: `render-ffmpeg.ts` scales a
 * 16:9 source up to cover 1080x1920 and crops the centre, so a 1080p source
 * contributes a 608px-wide strip and a 720p source only 405px. Lower
 * qualities are a real, visible downgrade, not a free saving — but they are
 * a large disk saving (measured: 1080p costs ~27 MB per minute of source),
 * so this is an option rather than a constant.
 */
const DEFAULT_VIDEO_QUALITY = "mp4-1080";

const NAVIGATION_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 15_000;
/**
 * How long to wait for the conversion itself. Measured live on 2026-08-29:
 * ~3.5s for a source ytmp3 had already converted, ~197s for a fresh 4h37m
 * one. 10 minutes is generous against that and still bounded well inside
 * the weekly job's own Actions timeout.
 */
const CONVERSION_TIMEOUT_MS = 600_000;
const POLL_INTERVAL_MS = 1_000;
const DOWNLOAD_TIMEOUT_MS = 900_000;
/**
 * Hard ceiling on what will be pulled onto the runner's disk. A
 * GitHub-hosted runner has ~14 GB free, and a multi-hour walkthrough at
 * 1080p is genuinely in this range (the 4h37m source measured above works
 * out to ~7.5 GB), so this is a real failure mode, not a theoretical one.
 * Checked against Content-Length *before* a byte is written; the cheaper
 * guard is `maxDurationS`, which rejects an over-long source before the
 * download starts at all.
 */
const MAX_DOWNLOAD_BYTES = 6 * 1024 * 1024 * 1024;

/**
 * Every selector below was read off the live page with a real browser on
 * 2026-08-29 and exercised end to end, not guessed. The page is a small,
 * stable, id-addressed state machine:
 *
 *   #videoUrl + .format-btn + #quality-select + #copyright-consent-checkbox
 *        │ #submit-button
 *        ▼
 *   .status  ("Checking copyright protection…" → "Preparing the video…" →
 *             "Checking video source…" → "Analyzing video details…" →
 *             "Fetching available formats…" → "Ready to download")
 *        │
 *        ├──► #download-btn[data-url][data-duration][data-filename]   (ready)
 *        └──► .status--error + #retry-btn                             (failed)
 *
 * Note `.status`'s text is read with `textContent`, never `innerText`: the
 * page renders in a way that drops the letter "s" from `innerText`
 * ("Plea e buy me a coffee"), so `innerText` matching is not safe here.
 * Nothing in this driver branches on that text anyway — it is logged as
 * progress evidence, and the *structure* (which element exists) is what
 * decides the outcome.
 */
const SELECTORS = {
  urlInput: "#videoUrl",
  formatButton: "button.format-btn",
  selectedFormatButton: "button.format-btn.selected",
  qualityTrigger: ".video-group-trigger",
  qualityItem: ".video-group-item",
  qualitySelect: "#quality-select",
  consentCheckbox: "#copyright-consent-checkbox",
  submitButton: "#submit-button",
} as const;

export interface DomYtmp3DownloadDriverOptions {
  /** Defaults to the real ytmp3.gg tool URL. Contract tests point this at a local fixture server. */
  toolUrl?: string;
  /** A `#quality-select` option value, e.g. `mp4-720`. Defaults to `mp4-1080`. */
  videoQuality?: string;
  /**
   * Whether this driver may tick ytmp3.gg's gating checkbox, which reads:
   * *"I confirm that I have read and agree to the standards in the Copyright
   * Disclaimer and will not download copyrighted content."*
   *
   * **Defaults to false, and that default is deliberate.** The checkbox
   * gates the Convert button, so with it off this driver cannot complete a
   * download and says so immediately. It is off anyway because ticking it is
   * an assertion made to a third party, and this project's own
   * `footage_sources.license_note` rows describe the material as copyrighted
   * walkthrough footage used under an explicitly accepted risk ("not a claim
   * of zero risk"). Those two statements contradict each other, and
   * resolving that is the operator's call to make knowingly, not a default
   * for a driver to assume.
   */
  acceptCopyrightAttestation?: boolean;
  navigationTimeoutMs?: number;
  actionTimeoutMs?: number;
  conversionTimeoutMs?: number;
  pollIntervalMs?: number;
  downloadTimeoutMs?: number;
  maxDownloadBytes?: number;
  ffprobeBin?: string;
}

/** Exactly what the page says, before any interpretation. Read in one round-trip so a single poll can never see a half-updated page. */
export interface RawConversionState {
  statusText: string;
  statusIsError: boolean;
  retryVisible: boolean;
  downloadVisible: boolean;
  downloadUrl: string;
  reportedDurationText: string;
  fileName: string;
}

export type ConversionState =
  | { kind: "pending"; statusText: string }
  | { kind: "failed"; statusText: string }
  | { kind: "ready"; statusText: string; fileUrl: string; fileName: string; reportedDurationS: number | null };

/**
 * The whole "is it done yet" decision, as a pure function over one page
 * reading — so the waiting logic is testable without standing up a browser,
 * the same discipline `youtube-search-dom.ts` applies to its tree walk.
 *
 * Ready wins over failed deliberately: the page keeps `#retry-btn` in the
 * DOM across states, and a run that has produced a real file URL has
 * succeeded whatever else is on screen.
 */
export function classifyConversionState(raw: RawConversionState): ConversionState {
  if (raw.downloadVisible && raw.downloadUrl.length > 0) {
    return {
      kind: "ready",
      statusText: raw.statusText,
      fileUrl: raw.downloadUrl,
      fileName: raw.fileName,
      reportedDurationS: parseReportedDurationS(raw.reportedDurationText),
    };
  }
  if (raw.statusIsError || raw.retryVisible) return { kind: "failed", statusText: raw.statusText };
  return { kind: "pending", statusText: raw.statusText };
}

/**
 * `data-duration` is the source video's length in whole seconds, as ytmp3
 * reports it (measured against a known 634.6s video: `635`). Anything that
 * isn't a positive finite number is null — "the page didn't say" — never 0,
 * which would read as a legitimately empty video and silently pass the
 * pre-flight check below.
 */
export function parseReportedDurationS(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const seconds = Number(text.trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/** One round-trip, no logic: the page hands back what it shows, every decision happens in Node (see `classifyConversionState`). */
async function readConversionState(page: Page): Promise<RawConversionState> {
  return page.evaluate(() => {
    const downloadButton = document.querySelector("#download-btn");
    const status = document.querySelector(".status");
    return {
      statusText: (status?.textContent ?? "").trim().slice(0, 120),
      statusIsError: document.querySelector(".status--error") !== null,
      retryVisible: (document.querySelector("#retry-btn")?.getClientRects().length ?? 0) > 0,
      downloadVisible: (downloadButton?.getClientRects().length ?? 0) > 0,
      downloadUrl: downloadButton?.getAttribute("data-url") ?? "",
      reportedDurationText: downloadButton?.getAttribute("data-duration") ?? "",
      fileName: downloadButton?.getAttribute("data-filename") ?? "",
    };
  });
}

/**
 * Converts + downloads one YouTube video through
 * `media.ytmp3.gg/tools/youtube-to-mp4-converter`, deterministically.
 *
 * Replaces `AgenticYtmp3DownloadDriver` (deleted 2026-08-29, operator
 * directive), which drove the same page through a Groq tool-calling loop.
 * That loop worked but had no business existing: the page is a fixed,
 * id-addressed form with three states, so "what do I click next" never had
 * more than one right answer. What it cost was real — every iteration
 * carried a page snapshot and ~600 tokens of tool schemas against the
 * tokens-per-day quota that binds this tier, and a single weekly run could
 * spend a whole day's allowance. Search was moved to plain code for the same
 * reason a week earlier (`youtube-search-dom.ts`); this finishes the job, and
 * FOOTAGE REFRESH now needs no model, and therefore no `GROQ_API_KEY`, at
 * all.
 *
 * Waiting is the part that genuinely needed care, and it is done by
 * feedback, not by sleeping: poll the page's own state machine until it
 * publishes a file URL or shows its error state, bounded by
 * `conversionTimeoutMs`. Measured live: ~3.5s cached, ~197s for a 4h37m
 * source, and a *bad* video id produces no error for ~20s before the page
 * admits it — which is exactly why the timeout, not a fixed sleep, is the
 * mechanism.
 *
 * Everything the page reports stays untrusted until proven: the file URL is
 * checked to be http(s) before it is fetched, Content-Length is checked
 * against a hard ceiling before a byte is written, and the downloaded file
 * is validated by ffprobe — a real video stream and a finite duration —
 * before `maxDurationS` is enforced against that *measured* duration. The
 * page's own `data-duration` is used only as a cheap pre-flight rejection,
 * never as the authoritative answer.
 */
export class DomYtmp3DownloadDriver implements DownloadDriver {
  private readonly ffprobeBin: string;

  constructor(private readonly options: DomYtmp3DownloadDriverOptions = {}) {
    this.ffprobeBin = options.ffprobeBin ?? "ffprobe";
  }

  async fetchVideo(req: DownloadRequest): Promise<Result<DownloadResponse, DriverError>> {
    const sourceVideoId = extractYoutubeVideoId(req.url);
    if (sourceVideoId === null) {
      return err({ kind: "invalid_response", message: `not a recognizable YouTube watch URL: ${req.url}`, retryable: false });
    }

    // Refused before a browser is launched rather than discovered five steps
    // in: the checkbox gates Convert, so without it there is nothing this
    // driver could do but fail slowly.
    if (this.options.acceptCopyrightAttestation !== true) {
      return err({
        kind: "policy_violation",
        message: "ytmp3.gg gates its Convert button behind a copyright attestation; acceptCopyrightAttestation is not enabled, so no download was attempted",
        retryable: false,
      });
    }

    const toolUrl = this.options.toolUrl ?? YTMP3_TOOL_URL;
    const origin = new URL(toolUrl).origin;
    const downloadsDir = await mkdtemp(join(tmpdir(), "ytmp3-dom-"));

    const session = await launchBrowserSession([origin]);
    try {
      const converted = await this.convert(session.page, toolUrl, req.url);
      if (!converted.ok) return converted;

      // Pre-flight: reject an over-long source *before* pulling gigabytes
      // onto the runner's disk. The old agentic driver could not do this —
      // ytmp3 exposes no metadata call — but the ready state's
      // `data-duration` attribute is right there, and it matched the real
      // file to within a second when measured. Still advisory: the same
      // check runs again below against ffprobe's measurement.
      const reported = converted.value.reportedDurationS;
      if (req.maxDurationS !== undefined && reported !== null && reported > req.maxDurationS) {
        return err({
          kind: "policy_violation",
          message: `ytmp3 reports the source is ${reported}s, exceeds maxDurationS=${req.maxDurationS} — refusing before downloading it`,
          retryable: false,
        });
      }

      const filePath = join(downloadsDir, `${sourceVideoId}.mp4`);
      const saved = await this.download(converted.value.fileUrl, filePath);
      if (!saved.ok) return saved;

      return this.validateAndFinish(filePath, sourceVideoId, req.maxDurationS);
    } finally {
      await session.close();
    }
  }

  /** Navigate → MP4 → quality → attestation → URL → Convert → wait for the page's own ready/failed state. */
  private async convert(page: Page, toolUrl: string, videoUrl: string): Promise<Result<{ fileUrl: string; reportedDurationS: number | null }, DriverError>> {
    const actionTimeout = this.options.actionTimeoutMs ?? ACTION_TIMEOUT_MS;
    const quality = this.options.videoQuality ?? DEFAULT_VIDEO_QUALITY;

    try {
      await page.goto(toolUrl, { waitUntil: "domcontentloaded", timeout: this.options.navigationTimeoutMs ?? NAVIGATION_TIMEOUT_MS });

      // The page defaults to MP3. Without this the pipeline would download
      // audio, which the ffprobe check below then rejects for having no
      // video stream — so this step is load-bearing, not cosmetic. Asserted
      // rather than assumed: a layout change that moves the format buttons
      // should fail here, loudly, not three steps later as a mystery.
      await page.locator(SELECTORS.formatButton, { hasText: /^\s*MP4\s*$/ }).first().click({ timeout: actionTimeout });
      const selectedFormat = (await page.locator(SELECTORS.selectedFormatButton).first().textContent({ timeout: actionTimeout }))?.trim();
      if (selectedFormat !== "MP4") {
        return err({ kind: "invalid_response", message: `clicked MP4 but the page still shows "${selectedFormat ?? "nothing"}" as the selected format`, retryable: false });
      }

      const qualityResult = await this.selectQuality(page, quality, actionTimeout);
      if (!qualityResult.ok) return qualityResult;

      await page.locator(SELECTORS.consentCheckbox).check({ timeout: actionTimeout });
      await page.locator(SELECTORS.urlInput).fill(videoUrl, { timeout: actionTimeout });
      await page.locator(SELECTORS.submitButton).click({ timeout: actionTimeout });
    } catch (cause) {
      return err({
        kind: "invalid_response",
        message: `ytmp3 conversion form could not be driven (the page's layout may have changed): ${describeError(cause)}`,
        retryable: false,
      });
    }

    return this.waitForConversion(page);
  }

  /**
   * The visible control is a custom dropdown of `.video-group-item` buttons;
   * the native `<select id="quality-select">` next to it carries the class
   * `quality-select--native-hidden` and, when set directly, updates its own
   * value while the app's visible state stays behind. So the dropdown is
   * driven and the native select is then read back as the assertion that the
   * app actually followed.
   */
  private async selectQuality(page: Page, quality: string, actionTimeout: number): Promise<Result<void, DriverError>> {
    const label = qualityOptionLabel(quality);
    if (label === null) {
      return err({ kind: "invalid_response", message: `videoQuality "${quality}" is not a recognizable ytmp3 MP4 option value (expected e.g. "mp4-1080")`, retryable: false });
    }

    await page.locator(SELECTORS.qualityTrigger).first().click({ timeout: actionTimeout });
    await page.locator(SELECTORS.qualityItem).filter({ hasText: exactLabelPattern(label) }).first().click({ timeout: actionTimeout });

    const applied = await page.locator(SELECTORS.qualitySelect).inputValue({ timeout: actionTimeout });
    if (applied !== quality) {
      return err({ kind: "invalid_response", message: `asked ytmp3 for ${quality} but the page settled on ${applied}`, retryable: false });
    }
    return ok(undefined);
  }

  /**
   * Polls the page's state machine rather than sleeping a guessed interval.
   * Status transitions are logged once each: this job's only evidence is CI
   * stdout, and "Analyzing video details…" every 30s is the difference
   * between a slow conversion and a hang.
   */
  private async waitForConversion(page: Page): Promise<Result<{ fileUrl: string; reportedDurationS: number | null }, DriverError>> {
    const timeoutMs = this.options.conversionTimeoutMs ?? CONVERSION_TIMEOUT_MS;
    const pollIntervalMs = this.options.pollIntervalMs ?? POLL_INTERVAL_MS;
    const startedAt = Date.now();
    let lastStatus = "";

    while (Date.now() - startedAt < timeoutMs) {
      const state = classifyConversionState(await readConversionState(page));
      if (state.statusText !== lastStatus && state.statusText.length > 0) {
        console.warn(`[ytmp3] ${Math.round((Date.now() - startedAt) / 1000)}s: ${state.statusText}`);
        lastStatus = state.statusText;
      }

      if (state.kind === "ready") {
        console.warn(`[ytmp3] ready after ${Math.round((Date.now() - startedAt) / 1000)}s: ${state.fileName || "(unnamed file)"}, reported duration ${state.reportedDurationS ?? "unknown"}s`);
        return ok({ fileUrl: state.fileUrl, reportedDurationS: state.reportedDurationS });
      }
      if (state.kind === "failed") {
        return err({
          kind: "provider_error",
          message: `ytmp3 reported a conversion failure${state.statusText.length > 0 ? `: ${state.statusText}` : ""}`,
          retryable: true,
        });
      }

      await page.waitForTimeout(pollIntervalMs);
    }

    return err({
      kind: "timeout",
      message: `ytmp3 did not publish a download URL within ${timeoutMs}ms (last status: ${lastStatus || "none"})`,
      retryable: true,
    });
  }

  /**
   * Streams the converted file straight to disk. Deliberately a plain
   * `fetch` and not a browser click: the file is served from a per-request
   * throwaway host (`vps-*.shop`, a different origin every time) that
   * `launchBrowserSession`'s navigation allowlist would — correctly — abort,
   * the response needs no cookie from the session, and streaming avoids
   * holding a multi-gigabyte file in memory the way a buffered read would.
   */
  private async download(fileUrl: string, destPath: string): Promise<Result<void, DriverError>> {
    let parsed: URL;
    try {
      parsed = new URL(fileUrl);
    } catch {
      return err({ kind: "invalid_response", message: "ytmp3 published a download URL that isn't a URL", retryable: false });
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return err({ kind: "invalid_response", message: `ytmp3 published a non-http download URL (${parsed.protocol})`, retryable: false });
    }

    const maxBytes = this.options.maxDownloadBytes ?? MAX_DOWNLOAD_BYTES;
    try {
      const response = await fetch(parsed, { signal: AbortSignal.timeout(this.options.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS) });
      if (!response.ok) {
        return err({ kind: "provider_error", message: `ytmp3 file host returned ${response.status} for the converted file`, retryable: true });
      }
      if (response.body === null) {
        return err({ kind: "invalid_response", message: "ytmp3 file host returned no response body", retryable: true });
      }

      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        return err({
          kind: "policy_violation",
          message: `converted file is ${contentLength} bytes, over the ${maxBytes}-byte ceiling — refusing to fill the runner's disk`,
          retryable: false,
        });
      }

      // Streamed through an async generator rather than `Readable.fromWeb`
      // so the byte ceiling is enforced on what actually arrives, not only
      // on a Content-Length header the host is free to omit or lie about.
      // `pipeline` still owns backpressure and error propagation.
      const reader = response.body.getReader();
      let bytesWritten = 0;
      let overLimit = false;
      await pipeline(
        (async function* () {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) return;
            bytesWritten += chunk.value.byteLength;
            if (bytesWritten > maxBytes) {
              overLimit = true;
              await reader.cancel();
              return;
            }
            yield chunk.value;
          }
        })(),
        createWriteStream(destPath),
      );

      if (overLimit) {
        await rm(destPath, { force: true });
        return err({
          kind: "policy_violation",
          message: `converted file exceeded the ${maxBytes}-byte ceiling mid-download — refusing to fill the runner's disk`,
          retryable: false,
        });
      }

      return ok(undefined);
    } catch (cause) {
      // A partial file is worse than none: it would ffprobe as a truncated
      // video or, worse, probe clean and get clipped.
      await rm(destPath, { force: true });
      const isAbort = cause instanceof Error && cause.name === "TimeoutError";
      return err({
        kind: isAbort ? "timeout" : "network",
        message: `downloading the converted file failed: ${describeError(cause)}`,
        retryable: true,
      });
    }
  }

  private async validateAndFinish(
    filePath: string,
    sourceVideoId: string,
    maxDurationS: number | undefined,
  ): Promise<Result<DownloadResponse, DriverError>> {
    const probeResult = await this.probeVideo(filePath);
    if (!probeResult.ok) return probeResult;
    const { durationS } = probeResult.value;

    if (maxDurationS !== undefined && durationS > maxDurationS) {
      return err({
        kind: "policy_violation",
        message: `downloaded video is ${durationS}s, exceeds maxDurationS=${maxDurationS} — refusing to use it`,
        retryable: false,
      });
    }

    return ok({ filePath, durationS, sourceVideoId });
  }

  /** Nothing downloaded here is ever executed — only probed by ffprobe and, if valid, handed to ffmpeg for clipping. A file that isn't a real video (a disguised payload, an ad redirect's HTML error page) fails here, not later in the pipeline. */
  private async probeVideo(filePath: string): Promise<Result<{ durationS: number }, DriverError>> {
    try {
      const { stdout } = await execFileAsync(
        this.ffprobeBin,
        ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", filePath],
        { signal: AbortSignal.timeout(30_000), maxBuffer: 8 * 1024 * 1024 },
      );
      const parsed: unknown = JSON.parse(stdout);
      if (!isFfprobeOutput(parsed)) {
        return err({ kind: "invalid_response", message: "ffprobe returned no usable output", retryable: false });
      }
      if (!(parsed.streams ?? []).some((s) => s.codec_type === "video")) {
        return err({ kind: "invalid_response", message: "downloaded file has no video stream — refusing to trust it", retryable: false });
      }
      const durationS = Number(parsed.format?.duration);
      if (!Number.isFinite(durationS)) {
        return err({ kind: "invalid_response", message: "ffprobe returned no usable duration", retryable: false });
      }
      return ok({ durationS });
    } catch (cause) {
      return err(classifyProbeError(cause));
    }
  }
}

/**
 * `mp4-1080` → `MP4 - 1080P`, the label the visible dropdown renders. Kept
 * as a total function over the option values the page actually offers
 * (`mp4-144` … `mp4-2160`) so a typo in configuration is a typed error
 * before a browser is launched, not a 15s click timeout.
 *
 * Matched against the dropdown with an anchored pattern, never a substring:
 * the live list is ordered `4K, 2K, 1080P Premium, 1080P, 720P, …`, so a
 * substring match for `MP4 - 1080P` would select **`MP4 - 1080P Premium`** —
 * a paid option sitting one row above the one that was asked for.
 */
export function qualityOptionLabel(quality: string): string | null {
  const match = /^mp4-(144|360|480|720|1080|1440|2160)$/.exec(quality);
  if (match === null) return null;
  const named: Record<string, string> = { "1440": "2K", "2160": "4K" };
  return `MP4 - ${named[match[1]] ?? `${match[1]}P`}`;
}

/** The label with surrounding whitespace tolerated and nothing else: see `qualityOptionLabel` for why a substring match is wrong here. */
function exactLabelPattern(label: string): RegExp {
  return new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);
}

interface FfprobeOutput {
  format?: { duration?: string };
  streams?: { codec_type?: string }[];
}
function isFfprobeOutput(value: unknown): value is FfprobeOutput {
  return typeof value === "object" && value !== null;
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function classifyProbeError(cause: unknown): DriverError {
  const message = describeError(cause);
  if (cause instanceof Error && cause.name === "AbortError") return { kind: "timeout", message, retryable: true };
  if (message.includes("ENOENT")) {
    return { kind: "provider_error", message: `${message} — is ffprobe installed?`, retryable: false };
  }
  // ffprobe exiting non-zero on the downloaded file is the "not actually a
  // video" case (or a transient truncated download) — never retryable as-is
  // since retrying without re-downloading would just re-probe the same bad
  // file, but it *is* the caller's (refreshFootageSource's) job to try the
  // next candidate, so this stays informative rather than fatal-looking.
  return { kind: "invalid_response", message: `ffprobe rejected the downloaded file: ${message}`, retryable: false };
}
