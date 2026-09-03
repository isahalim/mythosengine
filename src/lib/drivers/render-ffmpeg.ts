import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildAssSubtitles } from "./ass-subtitles.ts";
import type { DriverError, RenderDriver, RenderRequest, RenderResponse } from "./types.ts";
import { err, ok, type Result } from "../result.ts";

const execFileAsync = promisify(execFile);

/**
 * The frame every stage of the video pipeline targets. Exported because the
 * character overlay pass composites onto this pass's output and has to agree
 * with it about how big the frame is (character-overlay-ffmpeg.ts).
 */
export const OUTPUT_WIDTH = 1080;
export const OUTPUT_HEIGHT = 1920;

/**
 * FFmpeg, invoked as a subprocess — never a wasm/native-binding import, same
 * rationale as every other CLI-shaped driver here. Crops/scales the footage
 * to fill the full 1080x1920 frame (a superset of the ">=75% of frame
 * height" requirement in ARCHITECTURE.md §5.7 and the operator's reference
 * style), loops each clip to cover its slot, mutes the source entirely,
 * mixes in the narration track, and burns in the ASS captions from
 * ass-subtitles.ts.
 *
 * **This produces the finished video, and the finished video has no host in
 * it** (operator direction, 2026-09-03). The character used to be composited
 * inside this same filtergraph, under the caption burn-in. It is now its own
 * pass over this pass's output — see
 * `src/lib/drivers/character-overlay-ffmpeg.ts` for why, and for what that
 * buys.
 *
 * The footage track is a *list*: one clip is the gameplay path, several are
 * a stock montage cut to the script's beats. Normalising before `concat` is
 * not optional — the filter requires every input to agree on size, pixel
 * format, frame rate and sample aspect, and stock clips from different
 * photographers agree on none of them.
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
    if (req.footageClips.length === 0) {
      return err({ kind: "invalid_response", message: "compose() requires at least one footage clip", retryable: false });
    }
    // A multi-clip track has to say how long each shot is on screen: with no
    // duration there is nothing to cut on, and ffmpeg would play each clip's
    // full length in turn — a montage that runs minutes past its narration.
    // Caught here rather than discovered in the encoded file.
    if (req.footageClips.length > 1 && req.footageClips.some((clip) => clip.durationS === undefined)) {
      return err({ kind: "invalid_response", message: "a multi-clip footage track requires a durationS on every clip", retryable: false });
    }

    const dir = await mkdtemp(join(tmpdir(), "ffmpeg-render-"));
    const assPath = join(dir, "captions.ass");

    try {
      await writeFile(assPath, buildAssSubtitles(req.captionCues, OUTPUT_WIDTH, OUTPUT_HEIGHT), "utf8");

      await execFileAsync(
        this.ffmpegBin,
        [
          "-y",
          // Every clip loops, so a shot shorter than its slot fills it
          // instead of freezing on a last frame; `-t` then cuts the slot to
          // length. Both are INPUT options and have to precede their own
          // `-i`, which is why this is built per clip rather than once.
          ...req.footageClips.flatMap((clip) => [
            "-stream_loop",
            "-1",
            ...(clip.durationS === undefined ? [] : ["-t", clip.durationS.toFixed(3)]),
            "-i",
            clip.filePath,
          ]),
          "-i",
          req.narrationAudioPath,
          "-filter_complex",
          buildFilterGraph({ assPath, footageClipCount: req.footageClips.length }),
          "-map",
          "[v]",
          "-map",
          `${req.footageClips.length}:a`,
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          // Both, and they do different jobs: `-t` fixes the length when the
          // caller knows it, `-shortest` is the backstop for a caller that
          // does not. See RenderRequest.outputDurationS.
          ...(req.outputDurationS === undefined ? [] : ["-t", req.outputDurationS.toFixed(3)]),
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

/**
 * Frame rate every clip is resampled to before `concat`.
 *
 * Not a stylistic choice — `concat` refuses inputs whose frame rates differ,
 * and stock clips arrive at 24, 25, 30 and 60. 30 is the rate the gameplay
 * library is already pulled at, so the single-clip path is a no-op that
 * costs one filter and nothing visual. The character overlay pass resamples
 * the pack's 12fps to this same rate, for the same reason.
 */
export const OUTPUT_FPS = 30;

export interface FilterGraphSpec {
  assPath: string;
  footageClipCount: number;
  outputWidth?: number;
  outputHeight?: number;
}

/**
 * The filtergraph: footage, then captions.
 *
 * Order matters and is not arbitrary: the footage is normalised and
 * concatenated first and the captions are burned in on top of it.
 *
 * There is no host in this graph and no `colorkey` anywhere in this system —
 * see the module header and character-overlay-ffmpeg.ts.
 */
export function buildFilterGraph(spec: FilterGraphSpec): string {
  const outputWidth = spec.outputWidth ?? OUTPUT_WIDTH;
  const outputHeight = spec.outputHeight ?? OUTPUT_HEIGHT;

  // Each clip is scaled to cover the frame, cropped to it, and forced onto
  // one pixel format, sample aspect and frame rate. `concat` compares all
  // four and errors on any disagreement, and a stock montage is drawn from
  // whatever a dozen different photographers happened to shoot on.
  const normalizeFootage = (i: number): string =>
    `[${i}:v]scale=${outputWidth}:${outputHeight}:force_original_aspect_ratio=increase,` +
    `crop=${outputWidth}:${outputHeight},setsar=1,fps=${OUTPUT_FPS},format=yuv420p`;

  const chain: string[] = [];
  let video: string;

  if (spec.footageClipCount === 1) {
    // One clip needs no concat, and saying so keeps the gameplay path's
    // graph exactly as short as it was.
    chain.push(`${normalizeFootage(0)}[fg]`);
    video = "[fg]";
  } else {
    for (let i = 0; i < spec.footageClipCount; i++) chain.push(`${normalizeFootage(i)}[c${i}]`);
    const labels = Array.from({ length: spec.footageClipCount }, (_, i) => `[c${i}]`).join("");
    chain.push(`${labels}concat=n=${spec.footageClipCount}:v=1:a=0[fg]`);
    video = "[fg]";
  }

  chain.push(`${video}ass=${escapeFilterPath(spec.assPath)}[v]`);
  return chain.join(";");
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
