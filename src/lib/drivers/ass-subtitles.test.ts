import { describe, expect, it } from "vitest";
import { buildAssSubtitles } from "./ass-subtitles.ts";

describe("buildAssSubtitles", () => {
  it("declares the target resolution and one style", () => {
    const ass = buildAssSubtitles([], 1080, 1920);
    expect(ass).toContain("PlayResX: 1080");
    expect(ass).toContain("PlayResY: 1920");
    expect(ass).toContain("Style: Caption,");
  });

  it("emits one Dialogue line per cue with a fade tag", () => {
    const ass = buildAssSubtitles(
      [
        { text: "hello", startMs: 0, endMs: 500 },
        { text: "world", startMs: 500, endMs: 1000 },
      ],
      1080,
      1920,
    );
    const dialogueLines = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
    expect(dialogueLines).toHaveLength(2);
    expect(dialogueLines[0]).toContain("\\fad(80,80)");
    expect(dialogueLines[0]).toContain("hello");
    expect(dialogueLines[1]).toContain("world");
  });

  it("formats sub-hour, sub-minute timings correctly (H:MM:SS.cc)", () => {
    const ass = buildAssSubtitles([{ text: "x", startMs: 61_230, endMs: 61_500 }], 1080, 1920);
    expect(ass).toContain("0:01:01.23,0:01:01.50");
  });

  it("formats an hour-plus timing correctly", () => {
    const ass = buildAssSubtitles([{ text: "x", startMs: 3_661_000, endMs: 3_662_000 }], 1080, 1920);
    expect(ass).toContain("1:01:01.00,1:01:02.00");
  });

  it("escapes ASS override-tag braces in cue text so it can't inject styling", () => {
    const ass = buildAssSubtitles([{ text: "{\\pos(0,0)}evil", startMs: 0, endMs: 100 }], 1080, 1920);
    expect(ass).toContain("\\{\\\\pos(0,0)\\}evil");
    // the escaped text must not parse as a real ASS override block
    expect(ass).not.toMatch(/(?<!\\)\{\\pos/);
  });

  it("converts literal newlines to ASS line breaks", () => {
    const ass = buildAssSubtitles([{ text: "line one\nline two", startMs: 0, endMs: 100 }], 1080, 1920);
    expect(ass).toContain("line one\\Nline two");
  });

  it("returns just the header (no Dialogue lines) for zero cues", () => {
    const ass = buildAssSubtitles([], 1080, 1920);
    expect(ass).not.toContain("Dialogue:");
  });
});
