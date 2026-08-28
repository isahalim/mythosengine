import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildAssSubtitles } from "./ass-subtitles.ts";
import type { DriverError, RenderDriver, RenderRequest, RenderResponse } from "./types.ts";
import { err, ok, type Result } from "../result.ts";

const execFileAsync = promisify(execFile);

const OUTPUT_WIDTH = 1080;
const OUTPUT_HEIGHT = 1920;

/**
 * FFmpeg, invoked as a subprocess — never a wasm/native-binding import, same
 * rationale as every other CLI-shaped driver here. Crops/scales the footage
 * to fill the full 1080x1920 frame (a superset of the ">=75% of frame
 * height" requirement in ARCHITECTURE.md §5.7 and the operator's reference
 * style), loops it to cover the narration's length, mutes the source
 * entirely, mixes in the narration track, and burns in the ASS captions
 * from ass-subtitles.ts.
 */
export interface FfmpegRenderDriverOptions {
  ffmpegBin?: string; // defaults to "ffmpeg"
  ffprobeBin?: string; // defaults to "ffprobe"
  timeoutMs?: number;
}

export class FfmpegRenderDriver implements RenderDriver {
  private readonly ffmpegBin: string;
  private readonly ffprobeBin: string;
  private readonly timeoutMs: number;

  constructor(options: FfmpegRenderDriverOptions = {}) {
    this.ffmpegBin = options.ffmpegBin ?? "ffmpeg";
    this.ffprobeBin = options.ffprobeBin ?? "ffprobe";
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async compose(req: RenderRequest): Promise<Result<RenderResponse, DriverError>> {
    if (req.captionCues.length === 0) {
      return err({ kind: "invalid_response", message: "compose() requires at least one caption cue", retryable: false });
    }

    const dir = await mkdtemp(join(tmpdir(), "ffmpeg-render-"));
    const assPath = join(dir, "captions.ass");

    try {
      await writeFile(assPath, buildAssSubtitles(req.captionCues, OUTPUT_WIDTH, OUTPUT_HEIGHT), "utf8");

      await execFileAsync(
        this.ffmpegBin,
        [
          "-y",
          "-stream_loop",
          "-1",
          "-i",
          req.footageClipPath,
          "-i",
          req.narrationAudioPath,
          "-filter_complex",
          `[0:v]scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=increase,` +
            `crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT},setsar=1,ass=${escapeFilterPath(assPath)}[v]`,
          "-map",
          "[v]",
          "-map",
          "1:a",
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          "-shortest",
          req.outputPath,
        ],
        { signal: AbortSignal.timeout(this.timeoutMs) },
      );
    } catch (cause) {
      await rm(dir, { recursive: true, force: true });
      return err(classifyError(cause));
    }

    await rm(dir, { recursive: true, force: true });

    const durationResult = await this.probeDuration(req.outputPath);
    if (!durationResult.ok) return durationResult;

    return ok({ filePath: req.outputPath, durationS: durationResult.value });
  }

  private async probeDuration(filePath: string): Promise<Result<number, DriverError>> {
    try {
      const { stdout } = await execFileAsync(
        this.ffprobeBin,
        ["-v", "quiet", "-print_format", "json", "-show_format", filePath],
        { signal: AbortSignal.timeout(this.timeoutMs) },
      );
      const parsed: unknown = JSON.parse(stdout);
      const duration =
        typeof parsed === "object" && parsed !== null && "format" in parsed
          ? Number((parsed as { format: { duration?: string } }).format.duration)
          : Number.NaN;
      if (!Number.isFinite(duration)) {
        return err({ kind: "invalid_response", message: "ffprobe returned no usable duration", retryable: true });
      }
      return ok(duration);
    } catch (cause) {
      return err(classifyError(cause));
    }
  }
}

function escapeFilterPath(path: string): string {
  // ffmpeg's filtergraph parser treats ':' and other chars specially inside
  // a filter option value; escaping is required for the ass= file path.
  return path.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function classifyError(cause: unknown): DriverError {
  const message = cause instanceof Error ? cause.message : String(cause);
  const isAbort = cause instanceof Error && cause.name === "AbortError";
  if (isAbort) return { kind: "timeout", message, retryable: true };
  if (message.includes("ENOENT")) {
    return { kind: "provider_error", message: `${message} — is ffmpeg/ffprobe installed?`, retryable: false };
  }
  return { kind: "provider_error", message, retryable: true };
}
