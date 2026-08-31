import { describe, expect, it } from "vitest";
import { buildCaptionCues } from "./captions.ts";
import { buildAssSubtitles } from "../drivers/ass-subtitles.ts";
import type { TtsWordTiming } from "../drivers/types.ts";

function word(word: string, startMs: number, endMs: number): TtsWordTiming {
  return { word, startMs, endMs };
}

describe("buildCaptionCues", () => {
  it("groups consecutive words into one cue spanning their combined timing", () => {
    const timings = [word("this", 0, 200), word("is", 200, 350), word("huge", 350, 600)];
    const cues = buildCaptionCues(timings, 3);
    expect(cues).toEqual([
      {
        text: "this is huge",
        startMs: 0,
        endMs: 600,
        words: [
          { text: "this", startMs: 0, endMs: 200 },
          { text: "is", startMs: 200, endMs: 350 },
          { text: "huge", startMs: 350, endMs: 600 },
        ],
      },
    ]);
  });

  it("splits into multiple cues once a group fills up", () => {
    const timings = [word("a", 0, 100), word("b", 100, 200), word("c", 200, 300), word("d", 300, 400)];
    const cues = buildCaptionCues(timings, 2);
    expect(cues.map((c) => [c.text, c.startMs, c.endMs])).toEqual([
      ["a b", 0, 200],
      ["c d", 200, 400],
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

  it("carries each word's own timing, which is what per-word highlighting needs", () => {
    const cues = buildCaptionCues([word("a", 0, 100), word("b", 100, 250)], 2);
    expect(cues[0].words).toEqual([
      { text: "a", startMs: 0, endMs: 100 },
      { text: "b", startMs: 100, endMs: 250 },
    ]);
  });

  it("tags only the keywords a cue actually contains", () => {
    const timings = [word("the", 0, 100), word("patch", 100, 200), word("broke", 200, 300), word("nothing", 300, 400)];
    const cues = buildCaptionCues(timings, 2, ["patch", "meta"]);
    expect(cues[0].keywords).toEqual(["patch"]);
    // No keywords in this group, so no key at all rather than an empty array.
    expect(cues[1].keywords).toBeUndefined();
  });

  it("matches a keyword through the punctuation the narration carries", () => {
    const cues = buildCaptionCues([word("Patch.", 0, 100)], 1, ["patch"]);
    expect(cues[0].keywords).toEqual(["patch"]);
  });
});

describe("buildCaptionCues -> buildAssSubtitles", () => {
  const timings = [word("the", 0, 100), word("patch", 100, 200), word("broke", 200, 300)];

  it("emits one event per word, so exactly one word is accented at a time", () => {
    const ass = buildAssSubtitles(buildCaptionCues(timings, 3), 1080, 1920);
    const events = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
    expect(events).toHaveLength(3);
    for (const event of events) {
      expect(event.match(/\\c&H004BC2FF/g)).toHaveLength(1);
    }
  });

  it("holds each word's state until the next word begins, leaving no gap on a pause", () => {
    const gapped = [word("a", 0, 100), word("b", 400, 500)];
    const ass = buildAssSubtitles(buildCaptionCues(gapped, 2), 1080, 1920);
    const events = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
    // First word's event ends where the second begins (0:00:04.00 -> 0.4s), not at its own 0.1s end.
    expect(events[0]).toContain("0:00:00.00,0:00:00.40");
  });

  it("accents a keyword for the whole cue, not only while it is spoken", () => {
    const ass = buildAssSubtitles(buildCaptionCues(timings, 3, ["broke"]), 1080, 1920);
    const events = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
    // "broke" is accented in every event; the active word adds a second accent.
    expect(events[0].match(/\\c&H004BC2FF/g)).toHaveLength(2);
    expect(events[2].match(/\\c&H004BC2FF/g)).toHaveLength(1); // active word IS the keyword
  });

  it("fades in once and out once rather than flickering on every word", () => {
    const ass = buildAssSubtitles(buildCaptionCues(timings, 3), 1080, 1920);
    expect(ass.match(/\\fad\(80,0\)/g)).toHaveLength(1);
    expect(ass.match(/\\fad\(0,80\)/g)).toHaveLength(1);
  });
});
