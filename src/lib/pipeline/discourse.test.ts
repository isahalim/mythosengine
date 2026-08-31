import { describe, expect, it } from "vitest";
import type { DiscourseMove, DiscourseScriptResponse } from "./script-schema.ts";
import { beatWordRanges, describeViolations, discourseWordCount, estimatedReadSeconds, flattenBeats, validateBeatStructure } from "./discourse.ts";

/**
 * Beat text of a known length, so a test can ask for "a 60-second script"
 * without hand-counting words. 165 words per minute is the estimator's
 * constant, so 165 words is exactly one minute.
 */
function beatsOfWords(moves: readonly DiscourseMove[], wordsEach: number): { move: DiscourseMove; text: string }[] {
  return moves.map((move, i) => ({ move, text: `${move}${i} ${Array.from({ length: wordsEach - 1 }, (_, w) => `w${w}`).join(" ")}` }));
}

function script(moves: readonly DiscourseMove[], wordsEach = 10): DiscourseScriptResponse {
  return { hook: "Hook line here.", beats: beatsOfWords(moves, wordsEach), open_question: "So which is it?" };
}

/** Words per beat that puts a script of `beatCount` beats at almost exactly `seconds`. */
function wordsPerBeatFor(seconds: number, beatCount: number): number {
  const totalWords = (seconds / 60) * 165;
  return Math.round((totalWords - 3 - 4) / beatCount); // hook is 3 words, open_question 4
}

describe("flattenBeats", () => {
  it("speaks the hook, then every beat in order, then the closing question", () => {
    const s: DiscourseScriptResponse = {
      hook: "Everyone agrees on this.",
      beats: [
        { move: "question", text: "But why?" },
        { move: "attempt", text: "Maybe because it is cheap." },
      ],
      open_question: "Or is it?",
    };
    expect(flattenBeats(s)).toBe("Everyone agrees on this. But why? Maybe because it is cheap. Or is it?");
  });

  it("counts every spoken word, hook and closing question included", () => {
    const s = script(["question", "attempt", "pushback", "land"], 10);
    // 3 hook + 4 beats x 10 + 4 closing
    expect(discourseWordCount(s)).toBe(47);
  });
});

describe("validateBeatStructure", () => {
  const target = 60;
  const words = wordsPerBeatFor(target, 4);

  it("passes the canonical shape: question, attempt, pushback, land", () => {
    const s = script(["question", "attempt", "pushback", "land"], words);
    expect(validateBeatStructure(s, target)).toEqual([]);
  });

  it("rejects a lecture — attempt straight to land, never wrong once", () => {
    const s = script(["question", "attempt", "land", "land"], words);
    const violations = validateBeatStructure(s, target);
    expect(violations.map((v) => v.kind)).toContain("no_pushback");
  });

  it("rejects a pushback that sits after the last land, where it pushes back against nothing", () => {
    const s = script(["attempt", "land", "pushback", "reframe"], words);
    const violations = validateBeatStructure(s, target);
    expect(violations.map((v) => v.kind)).toEqual(["pushback_out_of_position"]);
    expect(violations[0].message).toContain("wrong before she is right");
  });

  it("rejects a pushback that comes before the first attempt", () => {
    const s = script(["pushback", "attempt", "land", "reframe"], words);
    expect(validateBeatStructure(s, target).map((v) => v.kind)).toEqual(["pushback_out_of_position"]);
  });

  it("rejects a script that never lands", () => {
    const s = script(["question", "attempt", "pushback", "reframe"], words);
    expect(validateBeatStructure(s, target).map((v) => v.kind)).toContain("no_land");
  });

  it("allows moves to repeat and to skip — the gate is not a template", () => {
    const s = script(["question", "question", "attempt", "pushback", "reframe", "pushback", "land"], wordsPerBeatFor(target, 7));
    expect(validateBeatStructure(s, target)).toEqual([]);
  });

  it("flags a script written far under the requested duration", () => {
    const s = script(["question", "attempt", "pushback", "land"], 5);
    const violations = validateBeatStructure(s, 180);
    expect(violations.map((v) => v.kind)).toContain("too_short");
  });

  it("flags a script written far over the requested duration", () => {
    const s = script(["question", "attempt", "pushback", "land"], 200);
    expect(validateBeatStructure(s, 60).map((v) => v.kind)).toContain("too_long");
  });

  it("tolerates being within 25% of the target, because the estimator is one constant standing in for delivery speed", () => {
    const s = script(["question", "attempt", "pushback", "land"], wordsPerBeatFor(target * 1.2, 4));
    expect(validateBeatStructure(s, target)).toEqual([]);
  });

  it("reports every violation at once, so one repair message can carry them all", () => {
    const s = script(["attempt", "reframe"], 4);
    const violations = validateBeatStructure(s, 180);
    expect(violations.map((v) => v.kind).sort()).toEqual(["no_land", "no_pushback", "too_short"]);
    expect(describeViolations(violations).split("\n")).toHaveLength(3);
  });
});

describe("estimatedReadSeconds", () => {
  it("reads 165 words as one minute", () => {
    const s: DiscourseScriptResponse = {
      hook: Array.from({ length: 55 }, (_, i) => `h${i}`).join(" "),
      beats: [{ move: "attempt", text: Array.from({ length: 55 }, (_, i) => `b${i}`).join(" ") }],
      open_question: Array.from({ length: 55 }, (_, i) => `q${i}`).join(" "),
    };
    expect(estimatedReadSeconds(s)).toBeCloseTo(60, 5);
  });
});

describe("beatWordRanges", () => {
  it("starts after the hook and runs contiguously through the beats", () => {
    const s: DiscourseScriptResponse = {
      hook: "One two three",
      beats: [
        { move: "question", text: "four five" },
        { move: "attempt", text: "six seven eight nine" },
      ],
      open_question: "ten",
    };
    expect(beatWordRanges(s)).toEqual([
      { beatIndex: 0, move: "question", startWord: 3, endWord: 5 },
      { beatIndex: 1, move: "attempt", startWord: 5, endWord: 9 },
    ]);
  });

  it("indexes into the same word sequence flattenBeats produces, so timings cannot drift from the audio", () => {
    const s = script(["question", "attempt", "pushback", "land"], 7);
    const allWords = flattenBeats(s).split(/\s+/);
    for (const range of beatWordRanges(s)) {
      expect(allWords.slice(range.startWord, range.endWord).join(" ")).toBe(s.beats[range.beatIndex].text);
    }
  });
});
