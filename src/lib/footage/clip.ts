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
