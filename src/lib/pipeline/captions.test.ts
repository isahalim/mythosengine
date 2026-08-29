import { describe, expect, it } from "vitest";
import { buildCaptionCues } from "./captions.ts";
import type { TtsWordTiming } from "../drivers/types.ts";

function word(word: string, startMs: number, endMs: number): TtsWordTiming {
  return { word, startMs, endMs };
}

describe("buildCaptionCues", () => {
  it("groups consecutive words into one cue spanning their combined timing", () => {
    const timings = [word("this", 0, 200), word("is", 200, 350), word("huge", 350, 600)];
    const cues = buildCaptionCues(timings, 3);
    expect(cues).toEqual([{ text: "this is huge", startMs: 0, endMs: 600 }]);
  });

  it("splits into multiple cues once a group fills up", () => {
    const timings = [word("a", 0, 100), word("b", 100, 200), word("c", 200, 300), word("d", 300, 400)];
    const cues = buildCaptionCues(timings, 2);
    expect(cues).toEqual([
      { text: "a b", startMs: 0, endMs: 200 },
      { text: "c d", startMs: 200, endMs: 400 },
    ]);
  });

  it("returns an empty array for no word timings", () => {
    expect(buildCaptionCues([], 3)).toEqual([]);
  });

  it("defaults to 3 words per group", () => {
    const timings = [word("a", 0, 100), word("b", 100, 200), word("c", 200, 300), word("d", 300, 400)];
    const cues = buildCaptionCues(timings);
    expect(cues).toHaveLength(2);
    expect(cues[0].text).toBe("a b c");
    expect(cues[1].text).toBe("d");
  });
});
