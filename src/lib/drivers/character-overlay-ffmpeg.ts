import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { OUTPUT_FPS, OUTPUT_HEIGHT } from "./render-ffmpeg.ts";
import type { CharacterOverlayRequest, CharacterClip, DriverError } from "./types.ts";
import { err, ok, type Result } from "../result.ts";

const execFileAsync = promisify(execFile);

/**
 * The host, composited over an already-finished video (operator direction,
 * 2026-09-03).
 *
 * **Why this is a second pass rather than four more inputs in the render's
 * filtergraph**, which is where the host lived until now:
 *
 * 1. *It is what the stage actually is.* RENDER produces a complete,
 *    publishable Short — footage cut to the beats, narration, burned-in
 *    captions. The host goes on top of that. Expressing it as a separate
 *    pass over a finished file makes the dependency literal instead of
 *    implied by filter ordering.
 * 2. *A failed overlay must not cost the video.* This pass can fail — a
 *    missing pack file, an encoder error — and when it does the caller still
 *    holds the finished no-host video and exports it flagged. Inside the
 *    render's graph the same failure took the render with it.
 * 3. *Input count.* The host track is one action per 2.5-4 seconds, so a
 *    128-second video is ~44 actions. As `-i` arguments that is 44
 *    concurrent decodes of lossless RGBA on the operator's own machine. As
 *    the concat demuxer it is **one** input, which is the whole reason the
 *    deterministic cycle is affordable at all.
 *
 * The concat demuxer works here because the pack is uniform: every one of
 * the 19 MOVs is `png / 640x680 / rgba / 12fps` (verified with ffprobe,
 * 2026-09-03). PNG is all-intra, so the one `outpoint` trim in a track — the
 * partial action that lands the goodbye wave on the end of the video — is
 * frame-exact rather than snapped to the nearest keyframe.
 *
 * The cost is one more encode of the finished video. That is accepted: the
 * audio is stream-copied so the narration never re-encodes, and a ~30-60s
 * pass sits inside a render that already spends nineteen minutes in EDIT.
 */
export interface FfmpegCharacterOverlayOptions {
  ffmpegBin?: string; // defaults to "ffmpeg"
  timeoutMs?: number;
}

export class FfmpegCharacterOverlayDriver {
  private readonly ffmpegBin: string;
  private readonly timeoutMs: number;

  constructor(options: FfmpegCharacterOverlayOptions = {}) {
    this.ffmpegBin = options.ffmpegBin ?? "ffmpeg";
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async composite(req: CharacterOverlayRequest): Promise<Result<{ filePath: string }, DriverError>> {
    // An empty track would write a concat list with no entries, which ffmpeg
    // reports as an unhelpful demuxer error a long way from its cause. The
    // caller's contract is to skip this pass entirely when there is no host.
    if (req.overlay.clips.length === 0) {
      return err({ kind: "invalid_response", message: "composite() was given an empty action track — skip this pass entirely to publish without the host", retryable: false });
    }
    if (!Number.isFinite(req.durationS) || req.durationS <= 0) {
      return err({ kind: "invalid_response", message: `composite() needs the finished video's duration; got ${req.durationS}`, retryable: false });
    }

    const dir = await mkdtemp(join(tmpdir(), "ffmpeg-host-"));
    const listPath = join(dir, "host.txt");

    try {
      await writeFile(listPath, buildConcatList(req.overlay.clips), "utf8");

      await execFileAsync(
        this.ffmpegBin,
        [
          "-y",
          "-i",
          req.videoPath,
          // Demuxer options are INPUT options and have to precede their own
          // `-i`. `-safe 0` is required for absolute paths in the list.
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          listPath,
          "-filter_complex",
          buildOverlayGraph({ heightRatio: req.overlay.heightRatio, bottomMarginRatio: req.overlay.bottomMarginRatio }),
          "-map",
          "[v]",
          "-map",
          "0:a",
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-pix_fmt",
          "yuv420p",
          // The narration is already AAC from the render pass. Copying it
          // means this second encode costs the picture one generation and the
          // audio nothing at all.
          "-c:a",
          "copy",
          // The host track is deliberately built to run past the end rather
          // than stop short of it (character-timeline.ts), so this is what
          // decides where the video ends. Without it the output would be as
          // long as the overshoot.
          "-t",
          req.durationS.toFixed(3),
          req.outputPath,
        ],
        { signal: AbortSignal.timeout(this.timeoutMs) },
      );
    } catch (cause) {
      await rm(dir, { recursive: true, force: true });
      return err(classifyError(cause));
    }

    await rm(dir, { recursive: true, force: true });
    return ok({ filePath: req.outputPath });
  }
}

/**
 * The ffconcat script naming every action in order.
 *
 * `outpoint` is written only for a clip that is genuinely trimmed. Writing
 * one for every entry would look more uniform and be worse: an outpoint set
 * to a file's own length depends on the manifest's `duration_ms` agreeing
 * with the container to the millisecond, and where it rounds short the last
 * frame of an action is silently dropped. A clip with no outpoint plays
 * whatever it actually contains.
 */
export function buildConcatList(clips: readonly CharacterClip[]): string {
  const lines = ["ffconcat version 1.0"];
  for (const clip of clips) {
    lines.push(`file '${escapeConcatPath(clip.filePath)}'`);
    if (clip.durationS < clip.naturalDurationS) lines.push(`outpoint ${clip.durationS.toFixed(3)}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * ffconcat quotes a path in single quotes, so a literal quote has to leave
 * and re-enter the quoting — `'\''` — and a backslash has to escape itself.
 * A pack in a directory with an apostrophe in its name is not hypothetical
 * on a machine where the repository lives under someone's home directory.
 */
function escapeConcatPath(path: string): string {
  return path.replace(/\\/g, "\\\\").replace(/'/g, `'\\''`);
}

export interface OverlayGraphSpec {
  heightRatio: number;
  bottomMarginRatio: number;
  outputHeight?: number;
}

/**
 * Input 0 is the finished video, input 1 is the concatenated host track.
 *
 * `yuva420p` — not `yuv420p` — is what carries the pack's 8-bit alpha into
 * `overlay`. Dropping the `a` flattens the host onto a black rectangle,
 * which is the one mistake in this graph that still encodes successfully.
 *
 * `-1` on the scale preserves each action's aspect ratio from the pack's
 * 640x680 canvas. Every action shares that canvas and framing, which is what
 * lets them hard-cut into each other without the host jumping.
 *
 * The host goes on top of the burned-in captions, which is safe rather than
 * lucky: the captions are ASS `Alignment: 5`, so they sit at the vertical
 * middle of the frame, while the host occupies from 10% to 44% of the height
 * measured from the bottom. The two do not meet. Moving either one is a
 * change that has to be checked against the other.
 */
export function buildOverlayGraph(spec: OverlayGraphSpec): string {
  const outputHeight = spec.outputHeight ?? OUTPUT_HEIGHT;
  const characterHeight = Math.round(outputHeight * spec.heightRatio);
  const bottomMargin = Math.round(outputHeight * spec.bottomMarginRatio);

  return (
    `[1:v]scale=-1:${characterHeight},setsar=1,fps=${OUTPUT_FPS},format=yuva420p[ch];` +
    // Centred horizontally, floating clear of the bottom edge — the robot is
    // drawn with its whole body visible rather than cropped by the frame, so
    // planting it flush on the bottom would read as a mistake. `shortest=0`
    // so the host can never truncate the video; `-t` decides the length.
    `[0:v][ch]overlay=(W-w)/2:H-h-${bottomMargin}:shortest=0[v]`
  );
}

function classifyError(cause: unknown): DriverError {
  const message = cause instanceof Error ? cause.message : String(cause);
  const isAbort = cause instanceof Error && cause.name === "AbortError";
  if (isAbort) return { kind: "timeout", message, retryable: true };
  if (message.includes("ENOENT")) {
    return { kind: "provider_error", message: `${message} — is ffmpeg installed?`, retryable: false };
  }
  return { kind: "provider_error", message, retryable: true };
}
