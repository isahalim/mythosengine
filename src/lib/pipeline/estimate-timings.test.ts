import { describe, expect, it } from "vitest";
import { estimateWordTimings } from "./estimate-timings.ts";

describe("estimateWordTimings", () => {
  it("spans exactly the measured narration, start to end", () => {
    // The audit package compares the last caption's end against the
    // narration's duration and flags a mismatch, so this boundary is the
    // one the estimator must not get wrong.
    const timings = estimateWordTimings(["one", "two", "three"], 6_000);
    expect(timings[0].startMs).toBe(0);
    expect(timings.at(-1)?.endMs).toBe(6_000);
  });

  it("never leaves a gap or an overlap between consecutive words", () => {
    const timings = estimateWordTimings("a bb ccc dddd eeeee".split(" "), 10_000);
    for (let i = 1; i < timings.length; i++) expect(timings[i].startMs).toBe(timings[i - 1].endMs);
  });

  it("gives a longer word more time than a short one", () => {
    const [short, long] = estimateWordTimings(["a", "consciousness"], 10_000);
    expect(long.endMs - long.startMs).toBeGreaterThan(short.endMs - short.startMs);
  });

  it("keeps the words in the order they were spoken", () => {
    expect(estimateWordTimings(["first", "second"], 1_000).map((t) => t.word)).toEqual(["first", "second"]);
  });

  it("returns nothing rather than dividing by zero", () => {
    expect(estimateWordTimings([], 5_000)).toEqual([]);
    expect(estimateWordTimings(["word"], 0)).toEqual([]);
  });
});
