import type { AsrDriver, TtsWordTiming } from "../drivers/types.ts";
import { alignBeats } from "./align.ts";
import type { BeatWordRange } from "./discourse.ts";
import { estimateWordTimings } from "./estimate-timings.ts";

/**
 * ALIGN, as one decision: where this render's word timings come from.
 *
 * Three outcomes, and the third is the reason this is a function rather
 * than a branch inside RENDER's 400-line main():
 *
 * - `native` — the TTS driver reported its own timings (Edge TTS's
 *   WordBoundary events). Exact, free, and nothing else runs.
 * - `aligned` — Gemini returned audio and no timings, so a transcript was
 *   force-aligned against the script.
 * - `estimated` — that failed, and the words are spread across the measured
 *   narration instead.
 *
 * The third one used to throw (operator direction, 2026-09-01: "don't make
 * the process fail even if the ALIGN fails"). A complete narration, a
 * complete script and a complete footage montage were being discarded
 * because one transcription call would not name a file format — the same
 * bad trade ARCHITECTURE.md §5.2.5 already refuses to make for RESEARCH.
 *
 * Extracted so all three outcomes are reachable in a test without a Gemini
 * key, a network, or an encoder: the degraded path is precisely the one that
 * is hardest to reach on purpose and worst to get wrong, because its output
 * is a video that looks fine until you read the captions.
 */
export interface AlignOutcome {
  wordTimings: TtsWordTiming[];
  /** Fraction of the script ALIGN matched, or null on the native and estimated paths. */
  alignMatchRatio: number | null;
  captionTiming: "native" | "aligned" | "estimated";
  /** Why the alignment was not used. Null unless `captionTiming` is `estimated`. */
  failure: { errorClass: string; message: string } | null;
}

export interface AlignStageInput {
  /** What the TTS driver reported. Non-empty means nothing else runs. */
  nativeTimings: readonly TtsWordTiming[];
  audio: Uint8Array<ArrayBuffer>;
  mimeType: string;
  scriptBody: string;
  beatRanges: readonly BeatWordRange[];
  /** The narration's measured length — what the estimate is spread across. */
  narrationDurationMs: number;
  asr: AsrDriver;
}

export async function resolveWordTimings(input: AlignStageInput): Promise<AlignOutcome> {
  if (input.nativeTimings.length > 0) {
    return { wordTimings: [...input.nativeTimings], alignMatchRatio: null, captionTiming: "native", failure: null };
  }

  const estimated = (errorClass: string, message: string): AlignOutcome => ({
    wordTimings: estimateWordTimings(input.scriptBody.split(/\s+/).filter(Boolean), input.narrationDurationMs),
    alignMatchRatio: null,
    captionTiming: "estimated",
    failure: { errorClass, message },
  });

  const transcript = await input.asr.transcribe({
    wordTimestamps: true,
    source: { kind: "audio", bytes: input.audio, mimeType: input.mimeType },
  });
  if (!transcript.ok) return estimated(transcript.error.kind, transcript.error.message);

  const aligned = alignBeats(transcript.value.words, input.scriptBody, input.beatRanges);
  if (!aligned.ok) return estimated(aligned.error.kind, aligned.error.message);

  return {
    wordTimings: aligned.value.wordTimings,
    alignMatchRatio: aligned.value.matchRatio,
    captionTiming: "aligned",
    failure: null,
  };
}
