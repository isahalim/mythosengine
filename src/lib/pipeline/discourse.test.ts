import { describe, expect, it } from "vitest";
import type { BeatMove, DiscourseScriptResponse } from "./script-schema.ts";
import { beatWordRanges, describeAdvisories, discourseWordCount, estimatedReadSeconds, flattenBeats, reviewScript, wordCountRange } from "./discourse.ts";

/**
 * Beat text of a known length, so a test can ask for "a 60-second script"
 * without hand-counting words. 165 words per minute is the estimator's
 * constant, so 165 words is exactly one minute.
 */
function beatsOfWords(moves: readonly BeatMove[], wordsEach: number): { move: BeatMove; text: string }[] {
  return moves.map((move, i) => ({ move, text: `${move}${i} ${Array.from({ length: wordsEach - 1 }, (_, w) => `w${w}`).join(" ")}` }));
}

function script(moves: readonly BeatMove[], wordsEach = 10): DiscourseScriptResponse {
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

describe("reviewScript", () => {
  const target = 60;
  const words = wordsPerBeatFor(target, 4);

  it("says nothing about a script that is roughly the right length, whatever shape it is", () => {
    // Every one of these was a hard failure until 2026-09-03. A story has no
    // pushback; an escalation has nothing to be wrong about; a hot take
    // states its verdict first. The gate could only ever describe a
    // discourse, so it made every script one.
    for (const moves of [
      ["question", "attempt", "pushback", "land"],
      ["setup", "escalation", "turn", "land"],
      ["verdict", "evidence", "escalation", "punchline"],
      ["confession", "setup", "reframe", "open"],
      ["attempt", "land", "pushback", "reframe"],
    ] as const) {
      expect(reviewScript(script([...moves], words), target)).toEqual([]);
    }
  });

  it("flags a script written far under the requested duration", () => {
    const s = script(["question", "attempt", "pushback", "land"], 5);
    expect(reviewScript(s, 180).map((a) => a.kind)).toEqual(["too_short"]);
  });

  it("flags a script written far over the requested duration", () => {
    const s = script(["question", "attempt", "pushback", "land"], 200);
    expect(reviewScript(s, 60).map((a) => a.kind)).toEqual(["too_long"]);
  });

  it("tolerates being within 25% of the target, because the estimator is one constant standing in for delivery speed", () => {
    const s = script(["question", "attempt", "pushback", "land"], wordsPerBeatFor(target * 1.2, 4));
    expect(reviewScript(s, target)).toEqual([]);
  });

  it("tells a mislengthed draft the word count to aim at, not only the seconds it missed by", () => {
    // The live 2026-09-03 run went under the floor, then over the ceiling,
    // because neither rejection named the number.
    const range = wordCountRange(90);
    const message = reviewScript(script(["question", "attempt", "pushback", "land"], 100), 90)[0].message;
    expect(message).toContain(`aim for about ${range.target}`);
    expect(message).toContain(`(${range.min}-${range.max})`);
    expect(describeAdvisories(reviewScript(script(["question", "attempt"], 100), 90)).split("\n")).toHaveLength(1);
  });

  it("measures spoken words, not delivery tags", () => {
    // A tagged script and its stripped twin are the same length. If they
    // were not, every video using non-verbal cues would read as too long and
    // burn its one rewrite on a phantom.
    const plain: DiscourseScriptResponse = { hook: "Hook line here.", beats: [{ move: "land", text: "one two three four five" }], open_question: "So which is it?" };
    const tagged: DiscourseScriptResponse = { hook: "[excitedly] Hook line here.", beats: [{ move: "land", text: "[giggles] one two three four five [sighs]" }], open_question: "[wistful] So which is it?" };
    expect(discourseWordCount(tagged)).toBe(discourseWordCount(plain));
    expect(reviewScript(tagged, 60)).toEqual(reviewScript(plain, 60));
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

describe("wordCountRange", () => {
  it("is the ruler AUDIT SUMMARY flags against, so the gate and the flag cannot disagree", () => {
    // 90s at 165 wpm is 248 words, ±25%.
    expect(wordCountRange(90)).toEqual({ target: 248, min: 186, max: 309 });
  });

  it("puts a script at the exact centre of its own range", () => {
    const s = script(["question", "attempt", "pushback", "land"], wordsPerBeatFor(120, 4));
    const range = wordCountRange(120);
    expect(discourseWordCount(s)).toBeGreaterThanOrEqual(range.min);
    expect(discourseWordCount(s)).toBeLessThanOrEqual(range.max);
  });
});
