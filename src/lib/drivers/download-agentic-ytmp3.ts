import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { launchBrowserSession, runBrowserAgentTask } from "./browser-agent-core.ts";
import { extractYoutubeVideoId } from "./youtube-url.ts";
import type { DownloadDriver, DownloadRequest, DownloadResponse, DriverError, LlmDriver } from "./types.ts";
import { err, ok, type Result } from "../result.ts";

const execFileAsync = promisify(execFile);

const YTMP3_TOOL_URL = "https://media.ytmp3.gg/tools/youtube-to-mp4-converter/dbismy";
const DEFAULT_MAX_ITERATIONS = 12;

const ResultSchema = z.object({ filePath: z.string() });

const SYSTEM_PROMPT = `You are a footage-download agent for an automated video pipeline, operating a
real browser on a real third-party ad-supported converter site. Only click
things that plausibly match what you were asked to do (the actual "convert"
or "download" control), never something that looks like an ad or an
unrelated call to action. If the page shows an error, a paywall, or you
cannot find a working control after a reasonable number of attempts, report
an empty filePath rather than guessing or clicking blindly. Re-snapshot the
page after every click that might change it — a conversion is not
instant.

Every model call you make is charged against a tokens-per-minute quota that
is this pipeline's binding constraint, so prefer the shortest path: the
control names you were given are real and were read off the live page. Do
not re-snapshot to rediscover something you were already told.`;

export interface AgenticYtmp3DownloadDriverOptions {
  llm: LlmDriver;
  ffprobeBin?: string;
  maxIterations?: number;
  actionTimeoutMs?: number;
  /** Defaults to the real ytmp3.gg tool URL. Contract tests point this at a local fixture server. */
  toolUrl?: string;
  /**
   * Whether the agent may tick ytmp3.gg's gating checkbox, which reads:
   * *"I confirm that I have read and agree to the standards in the Copyright
   * Disclaimer and will not download copyrighted content."*
   *
   * **Defaults to false, and that default is deliberate.** The checkbox
   * gates the Convert button, so with it off this driver will not complete a
   * download. It is off anyway because ticking it is an assertion made to a
   * third party, and this project's own `footage_sources.license_note` rows
   * describe the material as copyrighted walkthrough footage used under an
   * explicitly accepted risk ("not a claim of zero risk"). Those two
   * statements contradict each other, and resolving that is the operator's
   * call to make knowingly, not a default for a driver to assume.
   */
  acceptCopyrightAttestation?: boolean;
}

/**
 * The control names below were read off the live page on 2026-08-29 with a
 * real browser, not guessed. Naming them removes the exploratory
 * snapshot/click round-trips that made this leg both slow and unreliable —
 * the live run spent 12 of 12 iterations on clicks that each timed out
 * after the full 15s action budget without ever matching an element.
 *
 * Two details matter and neither was in the old instructions:
 *  - The page's format defaults to **MP3**. There are separate "MP3" and
 *    "MP4" buttons, and MP4 must be selected explicitly. Without that this
 *    driver would download audio, which `validateAndFinish`'s ffprobe check
 *    then rejects for having no video stream — so the leg could not have
 *    succeeded even if every click had landed.
 *  - The URL field is a `combobox` ("Paste URL or search keywords"), not a
 *    textbox, which is the role `browser_fill` has to be told to use.
 */
function buildUserGoal(toolUrl: string, videoUrl: string, mayAcceptAttestation: boolean): string {
  const attestationStep = mayAcceptAttestation
    ? `Tick the checkbox whose label begins "I confirm that I have read and agree" — the Convert button does nothing until it is checked. `
    : `Do NOT tick any confirmation or copyright checkbox; you are not authorized to agree to anything on this operator's behalf. If a checkbox blocks Convert, call report_download with an empty filePath and stop. `;

  return (
    `Navigate to ${toolUrl}. ` +
    `Fill the combobox named "Paste URL or search keywords" with ${videoUrl} using browser_fill with role "combobox". ` +
    `Click the button named "MP4" — the page defaults to MP3 and this pipeline needs video, so this step is required. ` +
    attestationStep +
    `Click the button named "Convert". Conversion is not instant: re-snapshot until a download control appears. ` +
    `Click the download control, then immediately call browser_wait_for_download. Once that returns a filePath, call report_download with it. ` +
    `If nothing works after a reasonable number of attempts, call report_download with an empty filePath.`
  );
}

/**
 * Replaces yt-dlp (download-ytdlp.ts, removed) per the operator's directive
 * — the prior driver's last six commits were all fighting YouTube's
 * bot-check with no durable fix. Drives
 * media.ytmp3.gg/tools/youtube-to-mp4-converter to convert+download the
 * given YouTube URL instead.
 *
 * ytmp3.gg gives no pre-flight metadata call the way yt-dlp's --dump-json
 * did, so maxDurationS is enforced *after* download, against the actual
 * file via ffprobe — the one authoritative check here. Everything the
 * browser agent itself reports (including "here's the file") is treated as
 * untrusted until ffprobe confirms the file is a real video, same
 * discipline as the search driver treating a reported URL as untrusted
 * until extractYoutubeVideoId confirms it.
 */
export class AgenticYtmp3DownloadDriver implements DownloadDriver {
  private readonly ffprobeBin: string;

  constructor(private readonly options: AgenticYtmp3DownloadDriverOptions) {
    this.ffprobeBin = options.ffprobeBin ?? "ffprobe";
  }

  async fetchVideo(req: DownloadRequest): Promise<Result<DownloadResponse, DriverError>> {
    const sourceVideoId = extractYoutubeVideoId(req.url);
    if (sourceVideoId === null) {
      return err({ kind: "invalid_response", message: `not a recognizable YouTube watch URL: ${req.url}`, retryable: false });
    }

    const toolUrl = this.options.toolUrl ?? YTMP3_TOOL_URL;
    const origin = new URL(toolUrl).origin;

    const downloadsDir = await mkdtemp(join(tmpdir(), "ytmp3-agentic-"));
    const session = await launchBrowserSession([origin]);
    try {
      const agentResult = await runBrowserAgentTask(
        {
          llm: this.options.llm,
          page: session.page,
          allowedOrigins: [origin],
          downloadsDir,
          maxIterations: this.options.maxIterations ?? DEFAULT_MAX_ITERATIONS,
          actionTimeoutMs: this.options.actionTimeoutMs,
          systemPrompt: SYSTEM_PROMPT,
          userGoal: buildUserGoal(toolUrl, req.url, this.options.acceptCopyrightAttestation === true),
        },
        {
          name: "report_download",
          description: "Report the local file path of the downloaded MP4 (from browser_wait_for_download's result), or an empty string if the download could not be completed.",
          parameters: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] },
          schema: ResultSchema,
        },
      );
      if (!agentResult.ok) return agentResult;
      if (agentResult.value.filePath.length === 0) {
        return err({ kind: "invalid_response", message: "agent could not complete the ytmp3 conversion/download", retryable: true });
      }

      return this.validateAndFinish(agentResult.value.filePath, sourceVideoId, req.maxDurationS);
    } finally {
      await session.close();
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

  /** Nothing downloaded here is ever executed — only probed by ffprobe and, if valid, handed to ffmpeg for clipping, exactly like the yt-dlp path did. A file that isn't a real video (a disguised payload, an ad redirect's HTML error page) fails here, not later in the pipeline. */
  private async probeVideo(filePath: string): Promise<Result<{ durationS: number }, DriverError>> {
    try {
      const { stdout } = await execFileAsync(
        this.ffprobeBin,
        ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", filePath],
        { signal: AbortSignal.timeout(30_000) },
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

interface FfprobeOutput {
  format?: { duration?: string };
  streams?: { codec_type?: string }[];
}
function isFfprobeOutput(value: unknown): value is FfprobeOutput {
  return typeof value === "object" && value !== null;
}

function classifyProbeError(cause: unknown): DriverError {
  const message = cause instanceof Error ? cause.message : String(cause);
  const isAbort = cause instanceof Error && cause.name === "AbortError";
  if (isAbort) return { kind: "timeout", message, retryable: true };
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
