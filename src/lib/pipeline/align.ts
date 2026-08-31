import type { AsrWord, TtsWordTiming } from "../drivers/types.ts";
import type { DiscourseMove } from "./script-schema.ts";
import type { BeatWordRange } from "./discourse.ts";
import { err, ok, type Result } from "../result.ts";

/**
 * Below this fraction of the script's words matched, the alignment is
 * refused rather than returned.
 *
 * ALIGN's output decides where captions appear and where footage cuts. A bad
 * alignment does not look like an error downstream — it looks like a video
 * whose captions drift and whose cuts land mid-sentence, which is a thing
 * you discover in review, minutes of render time later. Whisper transcribing
 * its own TTS audio should match nearly everything; 0.6 is well below the
 * expected rate and well above the rate you get when the audio and the
 * script are genuinely different content (the failure this catches: a stale
 * audio file, or a script/audio mismatch after a retry).
 */
const MIN_MATCH_RATIO = 0.6;

interface BeatBoundary {
  beatIndex: number;
  move: DiscourseMove;
  startMs: number;
  endMs: number;
}

export interface Alignment {
  wordTimings: TtsWordTiming[];
  beatBoundaries: BeatBoundary[];
  /** Fraction of the script's words found in the transcript — recorded in the audit package, not just used as a gate. */
  matchRatio: number;
}

/**
 * Words compared without punctuation, case or surrounding whitespace.
 *
 * Whisper punctuates on its own judgement and the script punctuates on the
 * model's; comparing raw strings would treat "notes." and "notes" as
 * different words and wreck the alignment on ordinary sentence endings.
 * Apostrophes are kept, because "its" and "it's" are genuinely different
 * words and collapsing them loses a real distinction for no gain.
 */
export function normalizeWord(word: string): string {
  return word
    .toLowerCase()
    .replace(/[^\p{L}\p{N}']/gu, "")
    .trim();
}

/**
 * Longest common subsequence between the script's words and the
 * transcript's, as a map from script index to transcript index.
 *
 * Alignment rather than a positional assumption, and that is the whole point
 * of this function. The obvious implementation — assume Whisper returns the
 * same number of words the script has, and index straight in — is wrong the
 * first time the model says "gonna" where the script wrote "going to", and
 * wrong in a way that silently shifts every subsequent beat boundary. LCS
 * absorbs insertions and deletions on either side and only maps the words it
 * is actually confident about.
 *
 * O(n×m) in time and memory. For a 180-second script that is roughly
 * 500×550 cells — trivial — and the format's ceiling bounds it, so there is
 * no input size worth optimizing for.
 */
export function alignWordSequences(scriptWords: readonly string[], asrWords: readonly string[]): Map<number, number> {
  const n = scriptWords.length;
  const m = asrWords.length;
  const table: Uint32Array = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number): number => i * (m + 1) + j;

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[at(i, j)] =
        scriptWords[i] === asrWords[j]
          ? table[at(i + 1, j + 1)] + 1
          : Math.max(table[at(i + 1, j)], table[at(i, j + 1)]);
    }
  }

  const mapping = new Map<number, number>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (scriptWords[i] === asrWords[j]) {
      mapping.set(i, j);
      i++;
      j++;
    } else if (table[at(i + 1, j)] >= table[at(i, j + 1)]) {
      i++;
    } else {
      j++;
    }
  }
  return mapping;
}

/**
 * ALIGN (plan v2 §4) — recovers word timings and beat boundaries from
 * force-aligned audio.
 *
 * Only the Gemini path needs this. Edge TTS emits `WordBoundary` events
 * natively, so its timings are exact and cost no call; Gemini returns audio
 * and nothing else, which is why this stage exists at all.
 *
 * The timings returned are the *transcript's*, not the script's: they are
 * what the audio actually says, at the times it says them, which is exactly
 * what a caption track needs. Beat boundaries are the derived half — the
 * script's beat texts are known, so mapping script positions onto transcript
 * positions puts each beat on the clock.
 *
 * Fails rather than approximates. A caller with no alignment can still ship
 * a video by falling back to the Edge path; a caller handed a confident-
 * looking bad alignment ships drifting captions and cuts that land mid-word.
 */
export function alignBeats(asrWords: readonly AsrWord[], spokenText: string, ranges: readonly BeatWordRange[]): Result<Alignment, { kind: "invalid_response"; message: string; retryable: boolean }> {
  if (asrWords.length === 0) {
    return err({ kind: "invalid_response", message: "ALIGN received no words from the transcript — the ASR call returned segments only", retryable: false });
  }

  const scriptWords = spokenText.split(/\s+/).filter(Boolean);
  if (scriptWords.length === 0) {
    return err({ kind: "invalid_response", message: "ALIGN received empty spoken text", retryable: false });
  }

  const mapping = alignWordSequences(scriptWords.map(normalizeWord), asrWords.map((w) => normalizeWord(w.word)));
  const matchRatio = mapping.size / scriptWords.length;
  if (matchRatio < MIN_MATCH_RATIO) {
    return err({
      kind: "invalid_response",
      message: `ALIGN matched only ${(matchRatio * 100).toFixed(0)}% of the script's ${scriptWords.length} words against the transcript's ${asrWords.length} (floor is ${MIN_MATCH_RATIO * 100}%) — the audio and the script do not appear to be the same content`,
      retryable: false,
    });
  }

  const wordTimings: TtsWordTiming[] = asrWords.map((w) => ({
    word: w.word.trim(),
    startMs: Math.round(w.start * 1000),
    endMs: Math.round(w.end * 1000),
  }));

  // Sorted once; every boundary lookup below is a scan over matched script
  // positions, and doing it repeatedly on an unsorted map would be both
  // slower and wrong.
  const matchedScriptIndices = [...mapping.keys()].sort((a, b) => a - b);

  /** The transcript index for the first matched script word at or after `scriptIndex`. */
  const firstMappedAtOrAfter = (scriptIndex: number): number | null => {
    for (const i of matchedScriptIndices) {
      if (i >= scriptIndex) return mapping.get(i) ?? null;
    }
    return null;
  };

  /** The transcript index for the last matched script word strictly before `scriptIndex`. */
  const lastMappedBefore = (scriptIndex: number): number | null => {
    let found: number | null = null;
    for (const i of matchedScriptIndices) {
      if (i >= scriptIndex) break;
      found = mapping.get(i) ?? found;
    }
    return found;
  };

  const beatBoundaries: BeatBoundary[] = ranges.map((range) => {
    // A beat whose own first word did not match falls back to the word after
    // the previous beat's last match, and finally to the clip's start. Each
    // step is a widening of the search, never an invented time.
    const startIdx = firstMappedAtOrAfter(range.startWord) ?? (lastMappedBefore(range.startWord) ?? -1) + 1;
    const endIdx = (lastMappedBefore(range.endWord) ?? startIdx);

    const start = wordTimings[Math.min(startIdx, wordTimings.length - 1)];
    const end = wordTimings[Math.min(Math.max(endIdx, startIdx), wordTimings.length - 1)];
    return { beatIndex: range.beatIndex, move: range.move, startMs: start.startMs, endMs: end.endMs };
  });

  return ok({ wordTimings, beatBoundaries, matchRatio });
}
