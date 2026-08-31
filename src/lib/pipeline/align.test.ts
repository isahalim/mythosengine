import { describe, expect, it } from "vitest";
import { alignBeats, alignWordSequences, normalizeWord } from "./align.ts";
import { beatWordRanges, flattenBeats } from "./discourse.ts";
import type { DiscourseScriptResponse } from "./script-schema.ts";
import type { AsrWord } from "../drivers/types.ts";

const SCRIPT: DiscourseScriptResponse = {
  hook: "Nobody reads the patch notes.",
  beats: [
    { move: "question", text: "So why does everyone have an opinion?" },
    { move: "attempt", text: "Maybe they trust the summary." },
    { move: "pushback", text: "Except the summary left out the nerf." },
    { move: "land", text: "The outrage was downstream of a footnote." },
  ],
  open_question: "Who does that serve?",
};

/** One ASR word per script word, half a second each — an exact transcription. */
function perfectTranscript(text: string): AsrWord[] {
  return text.split(/\s+/).map((word, i) => ({ word, start: i * 0.5, end: i * 0.5 + 0.5 }));
}

describe("normalizeWord", () => {
  it("strips punctuation and case so 'notes.' matches 'notes'", () => {
    expect(normalizeWord("Notes.")).toBe("notes");
    expect(normalizeWord("“patch”")).toBe("patch");
  });

  it("keeps apostrophes, because its and it's are different words", () => {
    expect(normalizeWord("it's")).toBe("it's");
    expect(normalizeWord("its")).toBe("its");
  });
});

describe("alignWordSequences", () => {
  it("maps one-to-one when the sequences are identical", () => {
    const mapping = alignWordSequences(["a", "b", "c"], ["a", "b", "c"]);
    expect([...mapping]).toEqual([[0, 0], [1, 1], [2, 2]]);
  });

  it("absorbs an insertion in the transcript without shifting later words", () => {
    const mapping = alignWordSequences(["a", "b", "c"], ["a", "um", "b", "c"]);
    expect(mapping.get(1)).toBe(2);
    expect(mapping.get(2)).toBe(3);
  });

  it("absorbs a deletion — a script word the audio never said", () => {
    const mapping = alignWordSequences(["a", "b", "c"], ["a", "c"]);
    expect(mapping.has(1)).toBe(false);
    expect(mapping.get(2)).toBe(1);
  });

  it("maps nothing when the sequences share no words", () => {
    expect(alignWordSequences(["a", "b"], ["x", "y"]).size).toBe(0);
  });
});

describe("alignBeats", () => {
  const spoken = flattenBeats(SCRIPT);
  const ranges = beatWordRanges(SCRIPT);

  it("returns the transcript's own timings as the word track", () => {
    const words = perfectTranscript(spoken);
    const result = alignBeats(words, spoken, ranges);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.wordTimings).toHaveLength(words.length);
    expect(result.value.wordTimings[0]).toEqual({ word: "Nobody", startMs: 0, endMs: 500 });
    expect(result.value.matchRatio).toBe(1);
  });

  it("puts each beat boundary on the words that beat actually contains", () => {
    const result = alignBeats(perfectTranscript(spoken), spoken, ranges);
    if (!result.ok) throw new Error("expected ok");

    const allWords = spoken.split(/\s+/);
    for (const boundary of result.value.beatBoundaries) {
      const range = ranges[boundary.beatIndex];
      // A perfect transcription means index i spans [i*500, i*500+500).
      expect(boundary.startMs).toBe(range.startWord * 500);
      expect(boundary.endMs).toBe((range.endWord - 1) * 500 + 500);
      expect(allWords.slice(range.startWord, range.endWord).join(" ")).toBe(SCRIPT.beats[boundary.beatIndex].text);
    }
  });

  it("carries each beat's move through, because that is what the renderer cuts on", () => {
    const result = alignBeats(perfectTranscript(spoken), spoken, ranges);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.beatBoundaries.map((b) => b.move)).toEqual(["question", "attempt", "pushback", "land"]);
  });

  it("survives a transcript that punctuates differently and adds a filler word", () => {
    const words = perfectTranscript(spoken.replace("Maybe they trust", "Maybe, uh, they trust"));
    const result = alignBeats(words, spoken, ranges);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    // The beat after the insertion still starts on its own first word.
    const attempt = result.value.beatBoundaries[1];
    expect(words[Math.round(attempt.startMs / 500)].word).toBe("Maybe,");
    expect(result.value.beatBoundaries[2].startMs).toBeGreaterThan(attempt.startMs);
  });

  it("boundaries stay ordered and non-overlapping across the whole script", () => {
    const result = alignBeats(perfectTranscript(spoken), spoken, ranges);
    if (!result.ok) throw new Error("expected ok");
    const boundaries = result.value.beatBoundaries;
    for (let i = 1; i < boundaries.length; i++) {
      expect(boundaries[i].startMs).toBeGreaterThanOrEqual(boundaries[i - 1].endMs);
    }
  });

  it("refuses an alignment against unrelated audio rather than returning drifting timings", () => {
    const result = alignBeats(perfectTranscript("completely different words about an unrelated subject entirely"), spoken, ranges);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.message).toContain("do not appear to be the same content");
  });

  it("refuses when the ASR call returned segments but no words", () => {
    const result = alignBeats([], spoken, ranges);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.message).toContain("no words from the transcript");
  });

  it("reports the match ratio even on success, so the audit package can record it", () => {
    const words = perfectTranscript(`${spoken} and one extra trailing phrase here`);
    const result = alignBeats(words, spoken, ranges);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.matchRatio).toBe(1);
  });
});
