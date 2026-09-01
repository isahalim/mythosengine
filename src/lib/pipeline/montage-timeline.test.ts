import { describe, expect, it } from "vitest";
import { buildMontageTimeline } from "./montage-timeline.ts";
import type { BeatWordRange } from "./discourse.ts";

/** 20 words, one per second — so a word index reads directly as a second. */
const wordTimings = Array.from({ length: 20 }, (_, i) => ({ word: `w${i}`, startMs: i * 1000, endMs: i * 1000 + 900 }));

const beatRanges: BeatWordRange[] = [
  { beatIndex: 0, move: "question", startWord: 4, endWord: 9 },
  { beatIndex: 1, move: "pushback", startWord: 9, endWord: 14 },
  { beatIndex: 2, move: "land", startWord: 14, endWord: 20 },
];

const parts = [
  { position: 0, beatIndex: null },
  { position: 1, beatIndex: 0 },
  { position: 2, beatIndex: 1 },
  { position: 3, beatIndex: 2 },
];

describe("buildMontageTimeline", () => {
  it("cuts on the script's beat boundaries, not on a grid", () => {
    const shots = buildMontageTimeline({ parts, wordTimings, beatRanges, narrationDurationMs: 20_000 });
    expect(shots.map((s) => [s.startMs, s.endMs])).toEqual([
      [0, 4_000],
      [4_000, 9_000],
      [9_000, 14_000],
      [14_000, 20_000],
    ]);
  });

  it("covers every millisecond exactly once — no gap and no overlap", () => {
    const shots = buildMontageTimeline({ parts, wordTimings, beatRanges, narrationDurationMs: 20_000 });
    expect(shots[0].startMs).toBe(0);
    expect(shots.at(-1)?.endMs).toBe(20_000);
    for (let i = 1; i < shots.length; i++) expect(shots[i].startMs).toBe(shots[i - 1].endMs);
  });

  it("runs the last shot to the end of the narration, past the final word", () => {
    // Trailing silence after the last word is still video that needs a
    // picture on it; ending with the words would leave black frames.
    const shots = buildMontageTimeline({ parts, wordTimings, beatRanges, narrationDurationMs: 26_000 });
    expect(shots.at(-1)?.endMs).toBe(26_000);
  });

  it("drops a shot too short to read and lets its neighbour hold through it", () => {
    const tightRanges: BeatWordRange[] = [
      { beatIndex: 0, move: "question", startWord: 4, endWord: 5 },
      // beat 1 starts 400ms after beat 0 — under the 900ms floor.
      { beatIndex: 1, move: "pushback", startWord: 5, endWord: 14 },
    ];
    const tightTimings = [...wordTimings];
    tightTimings[5] = { word: "w5", startMs: 4_400, endMs: 4_800 };

    const shots = buildMontageTimeline({
      parts: [
        { position: 0, beatIndex: null },
        { position: 1, beatIndex: 0 },
        { position: 2, beatIndex: 1 },
      ],
      wordTimings: tightTimings,
      beatRanges: tightRanges,
      narrationDurationMs: 20_000,
    });

    expect(shots.map((s) => s.position)).toEqual([0, 2]);
    // The dropped shot leaves no hole: the opener holds until beat 1.
    expect(shots[0].endMs).toBe(4_400);
    expect(shots[1].startMs).toBe(4_400);
  });

  it("divides evenly when there are no word timings at all — the ALIGN-failed path", () => {
    const shots = buildMontageTimeline({ parts, wordTimings: [], beatRanges, narrationDurationMs: 20_000 });
    expect(shots).toHaveLength(4);
    expect(shots.map((s) => s.startMs)).toEqual([0, 5_000, 10_000, 15_000]);
  });

  it("never produces a backwards shot when a beat range and the word list disagree", () => {
    // Ranges deliberately out of order: the seams between beats and the
    // transcript's words can disagree by a word, and a negative-length shot
    // is not something ffmpeg can be asked for.
    const reversed: BeatWordRange[] = [
      { beatIndex: 0, move: "question", startWord: 14, endWord: 20 },
      { beatIndex: 1, move: "land", startWord: 4, endWord: 9 },
    ];
    const shots = buildMontageTimeline({
      parts: [
        { position: 0, beatIndex: null },
        { position: 1, beatIndex: 0 },
        { position: 2, beatIndex: 1 },
      ],
      wordTimings,
      beatRanges: reversed,
      narrationDurationMs: 20_000,
    });
    for (const shot of shots) expect(shot.endMs).toBeGreaterThan(shot.startMs);
  });

  it("falls back to one clip for the whole narration when every shot would be a flicker", () => {
    const shots = buildMontageTimeline({ parts, wordTimings, beatRanges, narrationDurationMs: 800 });
    expect(shots).toHaveLength(1);
    expect(shots[0]).toMatchObject({ startMs: 0, endMs: 800 });
  });

  it("returns nothing when there is nothing to lay out", () => {
    expect(buildMontageTimeline({ parts: [], wordTimings, beatRanges, narrationDurationMs: 20_000 })).toEqual([]);
    expect(buildMontageTimeline({ parts, wordTimings, beatRanges, narrationDurationMs: 0 })).toEqual([]);
  });
});
