import type { CaptionCue, TtsWordTiming } from "../drivers/types.ts";

/**
 * Converts Edge TTS's per-word timings into the word-group caption cues
 * RENDER (`FfmpegRenderDriver`) burns in — ARCHITECTURE.md §5.6: "rendered
 * as bold, high-contrast text that fades word-group to word-group." No
 * existing helper did this conversion; `EdgeTtsDriver`'s output and
 * `FfmpegRenderDriver`'s input were never wired together before this
 * session's orchestrator needed to call both in sequence.
 */
export function buildCaptionCues(wordTimings: readonly TtsWordTiming[], wordsPerGroup = 3): CaptionCue[] {
  const cues: CaptionCue[] = [];
  for (let i = 0; i < wordTimings.length; i += wordsPerGroup) {
    const group = wordTimings.slice(i, i + wordsPerGroup);
    if (group.length === 0) continue;
    cues.push({
      text: group.map((w) => w.word).join(" "),
      startMs: group[0].startMs,
      endMs: group[group.length - 1].endMs,
    });
  }
  return cues;
}
