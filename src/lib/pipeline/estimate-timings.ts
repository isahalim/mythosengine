import type { TtsWordTiming } from "../drivers/types.ts";

/**
 * Word timings spread evenly across a narration of known length — the
 * degraded path RENDER takes when ALIGN fails.
 *
 * Operator direction, 2026-09-01: an ALIGN failure must not cost the run its
 * video. Until then a failed transcription threw, and a complete narration,
 * a complete script and a complete footage montage were discarded because
 * one API call would not name a file format.
 *
 * What this produces is honestly worse than either real source of timings.
 * Edge TTS reports the exact millisecond each word began; ALIGN recovers
 * almost that from a transcript. This assumes every word takes the same time,
 * which they do not — the captions stay in step across the video as a whole
 * and drift inside a sentence, most visibly around a pause. It is a
 * watchable video with imperfect captions instead of no video, and the audit
 * package records `captionTiming: "estimated"` so the reviewer is told which
 * one they are looking at rather than left to wonder why the words lag.
 *
 * Weighted by word length rather than a flat division: "the" and
 * "consciousness" are not the same length of sound, and character count is
 * the cheapest proxy that is right about that. It costs nothing and is
 * visibly better than uniform spacing on long words.
 */
export function estimateWordTimings(words: readonly string[], narrationDurationMs: number): TtsWordTiming[] {
  if (words.length === 0 || narrationDurationMs <= 0) return [];

  // +1 per word so a one-character word still has weight, and so a list of
  // empty strings cannot divide by zero.
  const weights = words.map((word) => word.trim().length + 1);
  const total = weights.reduce((sum, weight) => sum + weight, 0);

  const timings: TtsWordTiming[] = [];
  let cursorMs = 0;
  for (let i = 0; i < words.length; i++) {
    // The last word ends exactly at the narration's end rather than wherever
    // the accumulated rounding lands, so the caption track and the audio
    // agree at the one boundary the audit package actually checks.
    const endMs = i === words.length - 1 ? narrationDurationMs : Math.round(cursorMs + (weights[i] / total) * narrationDurationMs);
    timings.push({ word: words[i], startMs: Math.round(cursorMs), endMs });
    cursorMs = endMs;
  }
  return timings;
}
