import type { TtsWordTiming } from "../drivers/types.ts";
import type { BeatWordRange } from "./discourse.ts";

/**
 * When each shot in a stock montage is on screen.
 *
 * The cuts land on the script's own argument, not on a grid: a shot
 * acquired for beat 3 starts on the first word of beat 3 and runs until the
 * next shot's beat begins. That is the whole reason the footage is chosen
 * per beat (src/lib/footage/stock.ts) — a montage cut every N seconds
 * illustrates nothing in particular, and the moment a discourse script turns
 * is the moment the picture should.
 *
 * Pure, and separated from the acquisition for that reason: which shot is on
 * screen when is the part of this feature that can be wrong in a way you
 * only notice in the finished video, so it is the part that gets tested
 * without a network or an encoder anywhere near it.
 */

/**
 * A shot shorter than this reads as a flicker rather than as an image, so a
 * beat that would get less is dropped and its neighbour holds through it.
 * 900ms is about three words at this system's 165 wpm estimator.
 */
const MIN_SHOT_MS = 900;

export interface TimelineInput {
  /** Acquired clips in order. `beatIndex` null is the hook's establishing shot. */
  parts: { position: number; beatIndex: number | null }[];
  wordTimings: readonly TtsWordTiming[];
  /** Word spans per beat, from `beatWordRanges` — indexes into the same word list. */
  beatRanges: readonly BeatWordRange[];
  narrationDurationMs: number;
}

export interface TimelineShot {
  position: number;
  startMs: number;
  endMs: number;
  /** What the encoder needs: seconds this clip is on screen. */
  durationS: number;
}

/**
 * The start of the passage a shot illustrates.
 *
 * Falls back to an even division only when there are no word timings at all
 * — the ALIGN-failed path, where the caption timings are themselves
 * estimates. It does not fall back per beat: a missing range for one beat
 * among many means the ranges and the parts disagree, and quietly placing
 * that shot somewhere plausible would hide the disagreement.
 */
function startOf(
  part: { position: number; beatIndex: number | null },
  input: TimelineInput,
  index: number,
  total: number,
): number {
  if (part.beatIndex === null) return 0;
  if (input.wordTimings.length === 0) return Math.round((index / total) * input.narrationDurationMs);

  const range = input.beatRanges.find((r) => r.beatIndex === part.beatIndex);
  if (range === undefined) return Math.round((index / total) * input.narrationDurationMs);

  const word = input.wordTimings[Math.min(range.startWord, input.wordTimings.length - 1)];
  return word.startMs;
}

/**
 * Lays the acquired clips out across the narration.
 *
 * Every millisecond of the video is covered by exactly one shot: each runs
 * until the next one starts, and the last runs to the end of the narration.
 * A gap would be a black frame and an overlap would be a shot nobody chose.
 *
 * Shots too short to read are dropped rather than shown, so the returned
 * list can be shorter than the input — the caller composites what comes
 * back, not what it asked for.
 */
export function buildMontageTimeline(input: TimelineInput): TimelineShot[] {
  if (input.parts.length === 0) return [];
  if (input.narrationDurationMs <= 0) return [];

  const starts = input.parts.map((part, i) => ({
    position: part.position,
    startMs: startOf(part, input, i, input.parts.length),
  }));

  // The first shot always opens the video; starts never run backwards; and
  // no start lies past the end of the narration.
  //
  // All three are real cases, not defensive padding. A beat range and a word
  // list can disagree by a word at the seams, and a negative-length shot is
  // not a thing ffmpeg can be asked for. A start past the end happens
  // whenever the narration is shorter than the words suggest — a truncated
  // TTS response, or estimated timings against a measured duration — and
  // without the clamp those shots survive the length check below and are
  // composited past the audio, which is silent video the operator only finds
  // by watching to the end.
  starts[0].startMs = 0;
  for (let i = 1; i < starts.length; i++) {
    const clamped = Math.min(starts[i].startMs, input.narrationDurationMs);
    starts[i].startMs = clamped <= starts[i - 1].startMs ? starts[i - 1].startMs : clamped;
  }

  const shots: TimelineShot[] = [];
  for (let i = 0; i < starts.length; i++) {
    const startMs = starts[i].startMs;
    const endMs = i === starts.length - 1 ? input.narrationDurationMs : starts[i + 1].startMs;
    if (endMs - startMs < MIN_SHOT_MS) continue;
    shots.push({ position: starts[i].position, startMs, endMs, durationS: (endMs - startMs) / 1000 });
  }

  // Dropping a shot leaves a hole where it was; the previous shot holds
  // through it, and the first shot always starts at zero.
  for (let i = 0; i < shots.length; i++) {
    const nextStart = i === shots.length - 1 ? input.narrationDurationMs : shots[i + 1].startMs;
    shots[i].endMs = nextStart;
    shots[i].durationS = (nextStart - shots[i].startMs) / 1000;
  }
  if (shots.length > 0) {
    shots[0].startMs = 0;
    shots[0].durationS = (shots[0].endMs - shots[0].startMs) / 1000;
  }

  // Everything was too short to read — one clip held for the whole
  // narration beats a video made of flickers.
  if (shots.length === 0) {
    return [{ position: input.parts[0].position, startMs: 0, endMs: input.narrationDurationMs, durationS: input.narrationDurationMs / 1000 }];
  }

  return shots;
}
