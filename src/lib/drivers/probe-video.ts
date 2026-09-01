import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DriverError } from "./types.ts";
import { err, ok, type Result } from "../result.ts";

const execFileAsync = promisify(execFile);

const PROBE_TIMEOUT_MS = 30_000;

interface FfprobeOutput {
  format?: { duration?: string };
  streams?: { codec_type?: string }[];
}

function isFfprobeOutput(value: unknown): value is FfprobeOutput {
  return typeof value === "object" && value !== null;
}

export function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function classifyProbeError(cause: unknown): DriverError {
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

/**
 * The "is this actually a video" gate every download driver runs before
 * handing a file to the rest of the pipeline.
 *
 * Nothing downloaded by this system is ever executed — only probed here and,
 * if valid, handed to ffmpeg for clipping. A file that isn't a real video (a
 * disguised payload, an ad redirect's HTML error page, a truncated transfer,
 * an audio-only stream a format selector picked by mistake) fails here rather
 * than three stages later as a mystery.
 *
 * Shared by `download-ytmp3-dom.ts` and `download-ytdlp.ts`: the two
 * acquisition routes differ entirely in how they *get* a file and not at all
 * in what makes one acceptable, so this check lives once. Keeping it in one
 * place is what makes swapping acquisition routes a safe operation.
 */
/**
 * Duration of any media file, without asserting what kind it is.
 *
 * Split out from `probeVideo` because RENDER needs the narration audio's
 * length in two places — to spread caption timings when ALIGN fails, and to
 * cut a stock montage's shots to the narration — and `probeVideo`'s
 * video-stream check would reject a WAV for not being a video, which is the
 * one thing it is certainly allowed not to be.
 */
export async function probeDurationS(filePath: string, ffprobeBin = "ffprobe"): Promise<Result<number, DriverError>> {
  try {
    const { stdout } = await execFileAsync(ffprobeBin, ["-v", "quiet", "-print_format", "json", "-show_format", filePath], {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      maxBuffer: 8 * 1024 * 1024,
    });
    const parsed: unknown = JSON.parse(stdout);
    if (!isFfprobeOutput(parsed)) {
      return err({ kind: "invalid_response", message: "ffprobe returned no usable output", retryable: false });
    }
    const durationS = Number(parsed.format?.duration);
    if (!Number.isFinite(durationS) || durationS <= 0) {
      return err({ kind: "invalid_response", message: `ffprobe returned no usable duration for ${filePath}`, retryable: false });
    }
    return ok(durationS);
  } catch (cause) {
    return err(classifyProbeError(cause));
  }
}

export async function probeVideo(filePath: string, ffprobeBin = "ffprobe"): Promise<Result<{ durationS: number }, DriverError>> {
  try {
    const { stdout } = await execFileAsync(
      ffprobeBin,
      ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", filePath],
      { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), maxBuffer: 8 * 1024 * 1024 },
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
