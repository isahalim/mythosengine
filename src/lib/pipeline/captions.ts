import type { CaptionCue, TtsWordTiming } from "../drivers/types.ts";

/**
 * Converts per-word timings into the word-group caption cues RENDER
 * (`FfmpegRenderDriver`) burns in — ARCHITECTURE.md §5.6: "rendered as bold,
 * high-contrast text that fades word-group to word-group." No existing
 * helper did this conversion; `EdgeTtsDriver`'s output and
 * `FfmpegRenderDriver`'s input were never wired together before this
 * session's orchestrator needed to call both in sequence.
 *
 * The timings come from whichever path produced the audio: Edge TTS's native
 * `WordBoundary` events, or ALIGN's force-alignment of Gemini audio. This
 * function does not care which — that is the point of `TtsWordTiming` being
 * the one shape both produce.
 *
 * Each cue now also carries its own words, so the renderer can highlight the
 * word currently being spoken (plan v2 §1). `keywords` are accented for the
 * cue's whole life rather than only while spoken; they come from
 * `extractKeywords` (keywords.ts), the same model-free extractor the
 * console's montage uses.
 */
export function buildCaptionCues(wordTimings: readonly TtsWordTiming[], wordsPerGroup = 3, keywords: readonly string[] = []): CaptionCue[] {
  const cues: CaptionCue[] = [];
  const normalizedKeywords = keywords.map(normalize).filter(Boolean);

  for (let i = 0; i < wordTimings.length; i += wordsPerGroup) {
    const group = wordTimings.slice(i, i + wordsPerGroup);
    if (group.length === 0) continue;

    const words = group.map((w) => ({ text: w.word, startMs: w.startMs, endMs: w.endMs }));
    // Only the keywords this cue actually contains, so the renderer never
    // scans the whole script's keyword list per word.
    const present = normalizedKeywords.filter((k) => words.some((w) => normalize(w.text) === k));

    cues.push({
      text: group.map((w) => w.word).join(" "),
      startMs: group[0].startMs,
      endMs: group[group.length - 1].endMs,
      words,
      ...(present.length > 0 ? { keywords: present } : {}),
    });
  }
  return cues;
}

/** Same normalization the ASS builder uses, so a keyword matched here is a keyword accented there. */
function normalize(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
}
