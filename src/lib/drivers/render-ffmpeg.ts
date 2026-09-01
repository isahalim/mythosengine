import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildAssSubtitles } from "./ass-subtitles.ts";
import type { CharacterOverlay, DriverError, RenderDriver, RenderRequest, RenderResponse } from "./types.ts";
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
 *
 * The footage track is a *list* (2026-09-01). One clip is the gameplay path
 * and produces exactly the graph it always did; several are a stock montage
 * cut to the script's beats, each clip normalised to the output frame and
 * concatenated. Normalising before `concat` is not optional — the filter
 * requires every input to agree on size, pixel format, frame rate and
 * sample aspect, and stock clips from different photographers agree on none
 * of them.
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

      const overlay = req.characterOverlay;
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
          // The character loop is shorter than the narration (5.6s against
          // up to 180s), so it loops too. `-ignore_loop 0` is the GIF
          // demuxer's own flag; `-stream_loop -1` does not apply to it.
          ...(overlay ? ["-ignore_loop", "0", "-i", overlay.filePath] : []),
          "-filter_complex",
          buildFilterGraph(assPath, overlay, req.footageClips.length),
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
 * costs one filter and nothing visual.
 */
const OUTPUT_FPS = 30;

/**
 * The filtergraph, with or without the character.
 *
 * Order matters and is not arbitrary: the footage is normalised and
 * concatenated first, the keyed character is composited over it second, and
 * the captions are burned in last. Captions on top is the only arrangement
 * in which the character can never cover a word — she is anchored
 * bottom-centre, which is where the captions live, and a composite done
 * after the burn-in would occlude them.
 *
 * `colorkey` rather than `chromakey`: the asset's background is a flat sRGB
 * fill, which is exactly what colorkey's RGB distance handles, and
 * chromakey's YUV comparison would treat her face (same red channel as the
 * background) as closer to the key than it actually is.
 */
export function buildFilterGraph(
  assPath: string,
  overlay: CharacterOverlay | undefined,
  clipCount = 1,
  outputWidth = OUTPUT_WIDTH,
  outputHeight = OUTPUT_HEIGHT,
): string {
  // Each clip is scaled to cover the frame, cropped to it, and forced onto
  // one pixel format, sample aspect and frame rate. `concat` compares all
  // four and errors on any disagreement, and a stock montage is drawn from
  // whatever a dozen different photographers happened to shoot on.
  const normalize = (i: number): string =>
    `[${i}:v]scale=${outputWidth}:${outputHeight}:force_original_aspect_ratio=increase,` +
    `crop=${outputWidth}:${outputHeight},setsar=1,fps=${OUTPUT_FPS},format=yuv420p`;

  const chain: string[] = [];
  let video: string;

  if (clipCount === 1) {
    // One clip needs no concat, and saying so keeps the gameplay path's
    // graph exactly as short as it was.
    chain.push(`${normalize(0)}[fg]`);
    video = "[fg]";
  } else {
    for (let i = 0; i < clipCount; i++) chain.push(`${normalize(i)}[c${i}]`);
    const labels = Array.from({ length: clipCount }, (_, i) => `[c${i}]`).join("");
    chain.push(`${labels}concat=n=${clipCount}:v=1:a=0[fg]`);
    video = "[fg]";
  }

  if (overlay) {
    const characterHeight = Math.round(outputHeight * overlay.heightRatio);
    // The overlay is the input after the footage clips and the narration.
    const overlayIndex = clipCount + 1;
    // -1 preserves the asset's aspect ratio from its measured 800x600.
    chain.push(`[${overlayIndex}:v]scale=-1:${characterHeight},colorkey=${overlay.keyColor}:${overlay.similarity}:${overlay.blend}[ch]`);
    // Centred horizontally, sitting on the bottom edge. `shortest=0` so the
    // overlay never truncates the video — the narration decides the length.
    chain.push(`${video}[ch]overlay=(W-w)/2:H-h:shortest=0[composited]`);
    video = "[composited]";
  }

  chain.push(`${video}ass=${escapeFilterPath(assPath)}[v]`);
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
