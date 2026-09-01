import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildAssSubtitles } from "./ass-subtitles.ts";
import type { CharacterHold, CharacterOverlay, DriverError, RenderDriver, RenderRequest, RenderResponse } from "./types.ts";
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
      // The host's loop, stretched by her holds if she has any. Deriving a
      // file rather than folding the holds into the graph below is forced
      // by how they have to repeat: `loop` counts frames from the start of
      // the stream it is given, so against an endlessly looping input the
      // holds would land on the first pass through the asset and never
      // again. Against a finite file they land once, and the *result* is
      // what loops — so every cycle holds, which is what "every time it
      // reaches that frame" means.
      const overlayInput = await this.characterInputArgs(overlay, dir);
      if (!overlayInput.ok) {
        await rm(dir, { recursive: true, force: true });
        return err(overlayInput.error);
      }
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
          // up to 180s, ~20.5s once her holds are in), so it loops too.
          ...overlayInput.value,
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

  /**
   * The ffmpeg input flags for the character, deriving her held loop first
   * if she has holds.
   *
   * The two branches differ in more than the path. A GIF read straight from
   * the asset loops with `-ignore_loop 0`, the GIF demuxer's own flag, which
   * does not apply to anything else; the derived loop is a Matroska file and
   * loops with `-stream_loop -1`, which does not apply to GIFs.
   */
  private async characterInputArgs(overlay: CharacterOverlay | undefined, dir: string): Promise<Result<string[], DriverError>> {
    if (!overlay) return ok([]);
    if (overlay.holds === undefined || overlay.holds.length === 0) {
      return ok(["-ignore_loop", "0", "-i", overlay.filePath]);
    }
    const held = await this.deriveHeldLoop(overlay, overlay.holds, dir);
    if (!held.ok) return err(held.error);
    return ok(["-stream_loop", "-1", "-i", held.value]);
  }

  /**
   * Writes the character's loop back out with her holds in it.
   *
   * Lossless FFV1 rather than a second GIF, and that is not fussiness: a
   * re-encoded GIF gets a freshly quantised palette, and the flat `#e5505c`
   * key measured in character.ts comes back as `#fc4855` (checked against
   * this asset, 2026-09-01). The colorkey downstream is tight enough that
   * `0.14 begins eating her face` — a key that has moved 27 units is not a
   * key any more. FFV1 keeps every pixel exactly where it was.
   *
   * The frame rate and length come off the asset rather than being assumed,
   * so a hold means five seconds of screen time whatever the loop is pulled
   * at, and a hold that points past the end of the loop is caught here.
   */
  private async deriveHeldLoop(overlay: CharacterOverlay, holds: readonly CharacterHold[], dir: string): Promise<Result<string, DriverError>> {
    const source = await this.probeLoop(overlay.filePath);
    if (!source.ok) return err(source.error);

    const filter = buildHoldFilter(holds, source.value.fps, source.value.frameCount);
    if (!filter.ok) return err(filter.error);

    const heldPath = join(dir, "character-held.mkv");
    try {
      await execFileAsync(
        this.ffmpegBin,
        ["-y", "-i", overlay.filePath, "-vf", filter.value, "-c:v", "ffv1", heldPath],
        { signal: AbortSignal.timeout(this.timeoutMs) },
      );
    } catch (cause) {
      return err(classifyError(cause));
    }
    return ok(heldPath);
  }

  /**
   * The character loop's frame rate and exact length.
   *
   * `-count_frames` decodes the file to count, which is the only way to get
   * a trustworthy length out of a GIF — the header's `nb_frames` is absent
   * or wrong for most of them. It costs a decode of a 1.6 MB asset, next to
   * nothing beside the render it precedes.
   */
  private async probeLoop(filePath: string): Promise<Result<{ fps: number; frameCount: number }, DriverError>> {
    try {
      const { stdout } = await execFileAsync(
        this.ffprobeBin,
        [
          "-v",
          "quiet",
          "-print_format",
          "json",
          "-select_streams",
          "v:0",
          "-count_frames",
          "-show_entries",
          "stream=r_frame_rate,nb_read_frames",
          filePath,
        ],
        { signal: AbortSignal.timeout(this.timeoutMs) },
      );
      const stream = readFirstStream(JSON.parse(stdout) as unknown);
      if (stream === undefined) {
        return err({ kind: "invalid_response", message: `ffprobe reported no video stream in ${filePath}`, retryable: false });
      }
      const fps = parseFrameRate(stream.r_frame_rate);
      const frameCount = Number(stream.nb_read_frames);
      if (!Number.isFinite(fps) || fps <= 0) {
        return err({ kind: "invalid_response", message: `ffprobe returned no usable frame rate for ${filePath}`, retryable: false });
      }
      if (!Number.isInteger(frameCount) || frameCount < 1) {
        return err({ kind: "invalid_response", message: `ffprobe returned no usable frame count for ${filePath}`, retryable: false });
      }
      return ok({ fps, frameCount });
    } catch (cause) {
      return err(classifyError(cause));
    }
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

/**
 * The `-vf` chain that puts the holds into the character's loop.
 *
 * ffmpeg's `loop` filter is exactly the right tool and reads backwards from
 * how a person describes a hold: `loop=loop=N:size=S:start=F` buffers `S`
 * frames from `F` and replays them `N` more times, so a five-second freeze
 * is one frame replayed until five seconds of them have gone by, and a
 * five-second cycle over two frames is that pair replayed thirty-one times.
 * Everything is counted in frames, which is why the source frame rate has
 * to be measured rather than assumed.
 *
 * **`start` is 1-based**, so `atFrame` passes through untouched. The
 * documentation ("set first frame of loop") reads like the 0-based index
 * every other ffmpeg frame option uses, and it is not — measured against a
 * ten-frame ramp on 2026-09-01, `start=3` holds the *third* frame and
 * `start=10` holds the last one. Subtracting one to convert puts every hold
 * a frame early, which is invisible in a still and wrong in the video.
 *
 * **The holds are emitted last-first.** Each `loop` inserts frames into the
 * stream the next filter sees, so a hold applied at frame 3 shifts frames
 * 12 and 28 down the timeline and every later hold would land in the wrong
 * place. Descending order leaves every index still pointing at the frame it
 * was counted against.
 *
 * Nothing here degrades quietly. A hold past the end of the loop, an
 * overlapping pair, or one too short to add a single frame is a mistake in
 * the spec that would otherwise show up as a video that looks *almost*
 * right, so each returns an error the render surfaces.
 */
export function buildHoldFilter(holds: readonly CharacterHold[], sourceFps: number, sourceFrameCount: number): Result<string, DriverError> {
  const invalid = (message: string): Result<string, DriverError> => err({ kind: "invalid_response", message, retryable: false });

  if (holds.length === 0) return invalid("buildHoldFilter needs at least one hold");
  if (!Number.isFinite(sourceFps) || sourceFps <= 0) return invalid(`a character loop cannot run at ${sourceFps}fps`);
  if (!Number.isInteger(sourceFrameCount) || sourceFrameCount < 1) return invalid(`a character loop cannot be ${sourceFrameCount} frames long`);

  const ordered = [...holds].sort((a, b) => a.atFrame - b.atFrame);
  let previousEnd = 0;

  for (const hold of ordered) {
    if (!Number.isInteger(hold.atFrame) || hold.atFrame < 1) {
      return invalid(`hold at frame ${hold.atFrame}: frames are numbered from 1`);
    }
    if (!Number.isInteger(hold.frames) || hold.frames < 1) {
      return invalid(`hold at frame ${hold.atFrame}: a hold covers at least 1 frame, not ${hold.frames}`);
    }
    if (!(hold.seconds > 0)) {
      return invalid(`hold at frame ${hold.atFrame}: a hold lasts longer than 0s, not ${hold.seconds}s`);
    }
    const lastFrame = hold.atFrame + hold.frames - 1;
    if (lastFrame > sourceFrameCount) {
      return invalid(`hold at frame ${hold.atFrame} covers frame ${lastFrame}, but the loop is only ${sourceFrameCount} frames long`);
    }
    if (hold.atFrame <= previousEnd) {
      return invalid(`hold at frame ${hold.atFrame} overlaps the hold before it, which runs to frame ${previousEnd}`);
    }
    previousEnd = lastFrame;
  }

  const chain: string[] = [];
  // Last hold first: see above.
  for (const hold of [...ordered].reverse()) {
    // How many times the held frames play in total, then how many *extra*
    // plays that is — which is what `loop` counts.
    const plays = Math.round((hold.seconds * sourceFps) / hold.frames);
    if (plays < 2) {
      return invalid(
        `hold at frame ${hold.atFrame}: ${hold.seconds}s over ${hold.frames} frame(s) at ${sourceFps}fps adds nothing to the loop`,
      );
    }
    chain.push(`loop=loop=${plays - 1}:size=${hold.frames}:start=${hold.atFrame}`);
  }
  return ok(chain.join(","));
}

function readFirstStream(parsed: unknown): { r_frame_rate?: string; nb_read_frames?: string } | undefined {
  if (typeof parsed !== "object" || parsed === null || !("streams" in parsed)) return undefined;
  const { streams } = parsed as { streams: unknown };
  if (!Array.isArray(streams) || streams.length === 0) return undefined;
  const first: unknown = streams[0];
  if (typeof first !== "object" || first === null) return undefined;
  return first as { r_frame_rate?: string; nb_read_frames?: string };
}

/** ffprobe reports a rate as an exact rational ("25/2"), never a decimal. */
function parseFrameRate(value: string | undefined): number {
  if (value === undefined) return Number.NaN;
  const [numerator, denominator] = value.split("/");
  const n = Number(numerator);
  const d = denominator === undefined ? 1 : Number(denominator);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return Number.NaN;
  return n / d;
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
