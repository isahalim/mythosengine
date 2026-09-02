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
 * style), loops each clip to cover its slot, mutes the source entirely,
 * mixes in the narration track, composites the host over it, and burns in
 * the ASS captions from ass-subtitles.ts.
 *
 * Both video tracks are *lists* now. The footage track became one on
 * 2026-09-01 (a stock montage cut to the script's beats); the host followed
 * on the same day, when she stopped being one looping GIF and became an
 * ordered track of actions chosen per scene by PLAN
 * (src/lib/pipeline/character-timeline.ts). Normalising before `concat` is
 * not optional on either track — the filter requires every input to agree
 * on size, pixel format, frame rate and sample aspect, and stock clips from
 * different photographers agree on none of them.
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

    const overlay = req.characterOverlay;
    // An overlay declared with no actions would build a graph whose concat
    // has zero inputs — an ffmpeg error a long way from its cause. The
    // caller's contract is to omit the overlay entirely when there is no
    // host, so say which rule was broken.
    if (overlay !== undefined && overlay.clips.length === 0) {
      return err({ kind: "invalid_response", message: "characterOverlay was given with an empty clip track — omit it entirely to render without the host", retryable: false });
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
          // The host's actions, same treatment: each pack clip is 2.5-4s and
          // every one is a seamless loop, so looping to fill a longer scene
          // is invisible. This is what replaced the hand-counted frame holds
          // — holding an action is now just playing it again.
          ...(overlay?.clips ?? []).flatMap((clip) => ["-stream_loop", "-1", "-t", clip.durationS.toFixed(3), "-i", clip.filePath]),
          "-filter_complex",
          buildFilterGraph({
            assPath,
            footageClipCount: req.footageClips.length,
            ...(overlay ? { character: { clipCount: overlay.clips.length, heightRatio: overlay.heightRatio, bottomMarginRatio: overlay.bottomMarginRatio } } : {}),
          }),
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
 * costs one filter and nothing visual. The character pack runs at 12fps and
 * is resampled up to the same 30 by the same filter, which is what lets the
 * host's actions concatenate with each other at all.
 */
const OUTPUT_FPS = 30;

export interface FilterGraphSpec {
  assPath: string;
  footageClipCount: number;
  /** Absent means no host — the v1 look, and what a render falls back to when the pack is missing. */
  character?: { clipCount: number; heightRatio: number; bottomMarginRatio: number };
  outputWidth?: number;
  outputHeight?: number;
}

/**
 * The filtergraph, with or without the host.
 *
 * Order matters and is not arbitrary: the footage is normalised and
 * concatenated first, the host's action track is normalised and
 * concatenated second, it is composited over the footage third, and the
 * captions are burned in last. Captions on top is the only arrangement in
 * which the host can never cover a word — she is anchored near the bottom,
 * which is where the captions live, and a composite done after the burn-in
 * would occlude them.
 *
 * **There is no `colorkey` here any more.** The previous host was a GIF on
 * a flat `#e5505c` field whose key sat perilously close to her own face
 * colour; the pack's MOVs carry a real 8-bit alpha channel, so the host is
 * composited on the transparency she was authored with. `yuva420p` — not
 * `yuv420p` — is what carries that alpha through `concat` and into
 * `overlay`; dropping the `a` silently flattens the host onto a black
 * rectangle, which is the one mistake in this graph that still encodes
 * successfully.
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

  if (spec.character !== undefined && spec.character.clipCount > 0) {
    const { clipCount, heightRatio, bottomMarginRatio } = spec.character;
    const characterHeight = Math.round(outputHeight * heightRatio);
    // The host's inputs come after the footage clips and the narration.
    const firstCharacterInput = spec.footageClipCount + 1;

    // -1 preserves each action's aspect ratio from the pack's 640x680
    // canvas. Every action shares that canvas and framing, which is what
    // lets them hard-cut into each other without the host jumping.
    const normalizeCharacter = (i: number): string => `[${firstCharacterInput + i}:v]scale=-1:${characterHeight},setsar=1,fps=${OUTPUT_FPS},format=yuva420p`;

    let host: string;
    if (clipCount === 1) {
      chain.push(`${normalizeCharacter(0)}[ch]`);
      host = "[ch]";
    } else {
      for (let i = 0; i < clipCount; i++) chain.push(`${normalizeCharacter(i)}[h${i}]`);
      const labels = Array.from({ length: clipCount }, (_, i) => `[h${i}]`).join("");
      chain.push(`${labels}concat=n=${clipCount}:v=1:a=0[ch]`);
      host = "[ch]";
    }

    // Centred horizontally, floating clear of the bottom edge — the robot is
    // drawn with its whole body visible rather than cropped by the frame, so
    // planting it flush on the bottom would read as a mistake. `shortest=0`
    // so the host never truncates the video: the narration decides the
    // length.
    const bottomMargin = Math.round(outputHeight * bottomMarginRatio);
    chain.push(`${video}${host}overlay=(W-w)/2:H-h-${bottomMargin}:shortest=0[composited]`);
    video = "[composited]";
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
