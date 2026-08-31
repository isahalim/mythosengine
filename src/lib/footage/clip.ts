import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DriverError } from "../drivers/types.ts";
import { err, ok, type Result } from "../result.ts";

const execFileAsync = promisify(execFile);

export interface ClipOptions {
  ffmpegBin?: string;
  timeoutMs?: number;
}

/**
 * Extracts [startS, startS+durationS) from a source video into a standalone
 * clip file, re-encoded (not stream-copied) so the cut lands on an exact
 * frame boundary rather than the nearest keyframe. Used by the weekly
 * FOOTAGE REFRESH job to turn one motion-scored window into a
 * footage_segments candidate (ARCHITECTURE.md §5.0).
 */
export async function extractClip(
  sourcePath: string,
  startS: number,
  durationS: number,
  outputPath: string,
  options: ClipOptions = {},
): Promise<Result<{ filePath: string }, DriverError>> {
  const ffmpegBin = options.ffmpegBin ?? "ffmpeg";
  const timeoutMs = options.timeoutMs ?? 60_000;

  try {
    await execFileAsync(
      ffmpegBin,
      [
        "-y",
        "-ss",
        String(startS),
        "-i",
        sourcePath,
        "-t",
        String(durationS),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        outputPath,
      ],
      { signal: AbortSignal.timeout(timeoutMs) },
    );
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const isAbort = cause instanceof Error && cause.name === "AbortError";
    if (isAbort) return err({ kind: "timeout", message, retryable: true });
    if (message.includes("ENOENT")) {
      return err({ kind: "provider_error", message: `${message} — is ffmpeg installed?`, retryable: false });
    }
    return err({ kind: "provider_error", message, retryable: true });
  }

  return ok({ filePath: outputPath });
}

/**
 * Cuts the first and last `headTailS` seconds off a source video, writing
 * the remaining middle to `outputPath`. Run by FOOTAGE REFRESH the moment a
 * download lands, before any motion scoring, so the intro/outro/subscribe
 * card at either end of a walkthrough episode can never reach the library
 * (operator directive 2026-08-30).
 *
 * Stream-copied, not re-encoded: this runs over a full ~1h 1080p source and
 * a re-encode there would cost minutes of Actions time for a cut whose
 * exactness does not matter. `-c copy` lands the start on the nearest
 * preceding keyframe, so the real trim is `headTailS` *or slightly less* —
 * against a 600s buffer, a keyframe interval's worth of slop is noise.
 * `extractClip` above is the one that must be frame-exact, and is.
 *
 * Returns `policy_violation` rather than a truncated file when the source
 * is too short to survive both cuts — a caller that silently produced a
 * 0-second body would fail much later, somewhere less obvious.
 */
export async function trimHeadTail(
  sourcePath: string,
  sourceDurationS: number,
  headTailS: number,
  outputPath: string,
  options: ClipOptions = {},
): Promise<Result<{ filePath: string; keptFromS: number; keptDurationS: number }, DriverError>> {
  const ffmpegBin = options.ffmpegBin ?? "ffmpeg";
  const timeoutMs = options.timeoutMs ?? 300_000;

  const keptDurationS = sourceDurationS - 2 * headTailS;
  if (keptDurationS <= 0) {
    return err({
      kind: "policy_violation",
      message: `source is ${sourceDurationS}s, too short to drop ${headTailS}s from each end`,
      retryable: false,
    });
  }

  try {
    await execFileAsync(
      ffmpegBin,
      ["-y", "-ss", String(headTailS), "-i", sourcePath, "-t", String(keptDurationS), "-c", "copy", outputPath],
      { signal: AbortSignal.timeout(timeoutMs) },
    );
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const isAbort = cause instanceof Error && cause.name === "AbortError";
    if (isAbort) return err({ kind: "timeout", message, retryable: true });
    if (message.includes("ENOENT")) {
      return err({ kind: "provider_error", message: `${message} — is ffmpeg installed?`, retryable: false });
    }
    return err({ kind: "provider_error", message, retryable: true });
  }

  return ok({ filePath: outputPath, keptFromS: headTailS, keptDurationS });
}
