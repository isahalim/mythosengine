import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { FfmpegRenderDriver, buildHoldFilter } from "./render-ffmpeg.ts";
import type { CharacterHold, CharacterOverlay } from "./types.ts";

const fixturesDir = join(import.meta.dirname, "__fixtures__");
const fixture = (name: string) => join(fixturesDir, name);

const baseRequest = {
  footageClips: [{ filePath: "/tmp/does-not-need-to-exist-for-the-fixture.mp4" }],
  narrationAudioPath: "/tmp/does-not-need-to-exist-for-the-fixture.mp3",
  captionCues: [{ text: "hello", startMs: 0, endMs: 500 }],
  outputPath: "",
};

function withOutput(outputPath: string) {
  return { ...baseRequest, outputPath };
}

// Where fake-ffmpeg-record-argv.py appends each invocation it sees.
const argvLog = join(mkdtempSync(join(tmpdir(), "ffmpeg-argv-")), "argv.jsonl");
process.env.FFMPEG_ARGV_LOG = argvLog;

function readRecordedArgv(): string[][] {
  return readFileSync(argvLog, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as string[]);
}

beforeEach(() => {
  rmSync(argvLog, { force: true });
});

describe("FfmpegRenderDriver", () => {
  it("composes and returns the output path + duration on success", async () => {
    const driver = new FfmpegRenderDriver({
      ffmpegBin: fixture("fake-ffmpeg-success.py"),
      ffprobeBin: fixture("fake-ffprobe-success.py"),
    });
    const result = await driver.compose(withOutput("/tmp/render-test-output.mp4"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.filePath).toBe("/tmp/render-test-output.mp4");
      expect(result.value.durationS).toBe(12.34);
    }
  });

  it("rejects an empty caption-cue list before ever invoking ffmpeg", async () => {
    const driver = new FfmpegRenderDriver({ ffmpegBin: fixture("fake-ffmpeg-fail.py") });
    const result = await driver.compose({ ...baseRequest, captionCues: [], outputPath: "/tmp/x.mp4" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("invalid_response");
      expect(result.error.retryable).toBe(false);
    }
  });

  it("reports a retryable provider_error when ffmpeg exits non-zero", async () => {
    const driver = new FfmpegRenderDriver({ ffmpegBin: fixture("fake-ffmpeg-fail.py") });
    const result = await driver.compose(withOutput("/tmp/render-test-never-written.mp4"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("provider_error");
      expect(result.error.retryable).toBe(true);
    }
  });

  it("reports invalid_response when ffprobe can't find a usable duration", async () => {
    const driver = new FfmpegRenderDriver({
      ffmpegBin: fixture("fake-ffmpeg-success.py"),
      ffprobeBin: fixture("fake-ffprobe-bad-output.py"),
    });
    const result = await driver.compose(withOutput("/tmp/render-test-output-2.mp4"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid_response");
  });

  it("rejects an empty footage track before ever invoking ffmpeg", async () => {
    const driver = new FfmpegRenderDriver({ ffmpegBin: fixture("fake-ffmpeg-fail.py") });
    const result = await driver.compose({ ...baseRequest, footageClips: [], outputPath: "/tmp/x.mp4" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("invalid_response");
      expect(result.error.retryable).toBe(false);
    }
  });

  it("refuses a montage whose clips do not say how long they are on screen", async () => {
    // Without a duration there is nothing to cut on and ffmpeg would play
    // each clip in full — a montage running minutes past its narration,
    // which is the kind of thing you find in the finished file.
    const driver = new FfmpegRenderDriver({ ffmpegBin: fixture("fake-ffmpeg-fail.py") });
    const result = await driver.compose({
      ...baseRequest,
      footageClips: [{ filePath: "/tmp/a.mp4", durationS: 4 }, { filePath: "/tmp/b.mp4" }],
      outputPath: "/tmp/x.mp4",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("durationS");
  });

  it("accepts a multi-clip montage with durations", async () => {
    const driver = new FfmpegRenderDriver({
      ffmpegBin: fixture("fake-ffmpeg-success.py"),
      ffprobeBin: fixture("fake-ffprobe-success.py"),
    });
    const result = await driver.compose({
      ...baseRequest,
      footageClips: [
        { filePath: "/tmp/a.mp4", durationS: 4 },
        { filePath: "/tmp/b.mp4", durationS: 6.5 },
      ],
      outputPath: "/tmp/render-test-montage.mp4",
    });
    expect(result.ok).toBe(true);
  });

  it("fails with a non-retryable provider_error when ffmpeg itself can't be found", async () => {
    const driver = new FfmpegRenderDriver({ ffmpegBin: "definitely-not-a-real-binary-xyz" });
    const result = await driver.compose(withOutput("/tmp/x.mp4"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("provider_error");
      expect(result.error.retryable).toBe(false);
    }
  });
});

const overlayWithHolds = (holds: readonly CharacterHold[]): CharacterOverlay => ({
  filePath: "/tmp/character.gif",
  keyColor: "0xe5505c",
  similarity: 0.1,
  blend: 0,
  heightRatio: 0.34,
  holds,
});

describe("buildHoldFilter", () => {
  // 12.5fps, so a five-second hold is 62.5 frames of screen time.
  const FPS = 12.5;
  const FRAMES = 70;

  it("freezes a single frame for the whole hold", () => {
    const result = buildHoldFilter([{ atFrame: 12, frames: 1, seconds: 5 }], FPS, FRAMES);
    expect(result.ok).toBe(true);
    // 63 plays of one frame = 62 extra = 5.04s. `start` is 1-based:
    // measured, not assumed -- see buildHoldFilter.
    if (result.ok) expect(result.value).toBe("loop=loop=62:size=1:start=12");
  });

  it("cycles a multi-frame hold instead of freezing it", () => {
    const result = buildHoldFilter([{ atFrame: 3, frames: 2, seconds: 5 }], FPS, FRAMES);
    // 62.5 frames over a 2-frame set = 31 plays = 30 extra = 4.96s.
    if (result.ok) expect(result.value).toBe("loop=loop=30:size=2:start=3");
    expect(result.ok).toBe(true);
  });

  it("emits the holds last-first so no hold shifts the one after it", () => {
    // Applied in ascending order, the frame-3 hold would insert 62 frames
    // ahead of frame 12 and the next two holds would land 62 and 124 frames
    // late -- a video that looks almost right, which is the worst kind.
    const result = buildHoldFilter(
      [
        { atFrame: 3, frames: 2, seconds: 5 },
        { atFrame: 12, frames: 1, seconds: 5 },
        { atFrame: 28, frames: 1, seconds: 5 },
      ],
      FPS,
      FRAMES,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("loop=loop=62:size=1:start=28,loop=loop=62:size=1:start=12,loop=loop=30:size=2:start=3");
    }
  });

  it("orders the holds itself rather than trusting the caller's order", () => {
    const shuffled = buildHoldFilter(
      [
        { atFrame: 28, frames: 1, seconds: 5 },
        { atFrame: 3, frames: 2, seconds: 5 },
        { atFrame: 12, frames: 1, seconds: 5 },
      ],
      FPS,
      FRAMES,
    );
    expect(shuffled.ok).toBe(true);
    if (shuffled.ok) expect(shuffled.value.startsWith("loop=loop=62:size=1:start=28")).toBe(true);
  });

  it("scales the repeat count to the source frame rate", () => {
    // The same five seconds against a 30fps loop is 150 frames, not 63.
    const result = buildHoldFilter([{ atFrame: 12, frames: 1, seconds: 5 }], 30, FRAMES);
    if (result.ok) expect(result.value).toBe("loop=loop=149:size=1:start=12");
    expect(result.ok).toBe(true);
  });

  it("allows a hold on the last frame of the loop", () => {
    // start == frameCount is in range, not off the end: measured against
    // the ramp, `start=10` on a ten-frame source holds the last frame.
    expect(buildHoldFilter([{ atFrame: 70, frames: 1, seconds: 5 }], FPS, FRAMES).ok).toBe(true);
  });

  it("refuses a hold that runs past the end of the loop", () => {
    // The frame numbers were counted off one specific asset. Swapping in a
    // shorter loop has to fail here, not silently drop the hold.
    const result = buildHoldFilter([{ atFrame: 70, frames: 2, seconds: 5 }], FPS, FRAMES);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("only 70 frames long");
  });

  it("refuses overlapping holds", () => {
    const result = buildHoldFilter(
      [
        { atFrame: 3, frames: 2, seconds: 5 },
        { atFrame: 4, frames: 1, seconds: 5 },
      ],
      FPS,
      FRAMES,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("overlaps");
  });

  it("refuses a hold too short to add a frame", () => {
    const result = buildHoldFilter([{ atFrame: 12, frames: 1, seconds: 0.05 }], FPS, FRAMES);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("adds nothing");
  });

  it("refuses a frame number counted from zero", () => {
    const result = buildHoldFilter([{ atFrame: 0, frames: 1, seconds: 5 }], FPS, FRAMES);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("numbered from 1");
  });

  it("refuses an unusable frame rate rather than dividing by it", () => {
    expect(buildHoldFilter([{ atFrame: 12, frames: 1, seconds: 5 }], 0, FRAMES).ok).toBe(false);
    expect(buildHoldFilter([{ atFrame: 12, frames: 1, seconds: 5 }], Number.NaN, FRAMES).ok).toBe(false);
  });
});

describe("FfmpegRenderDriver character input", () => {
  it("derives a held loop and loops the derived file, not the asset", async () => {
    const driver = new FfmpegRenderDriver({
      ffmpegBin: fixture("fake-ffmpeg-record-argv.py"),
      ffprobeBin: fixture("fake-ffprobe-success.py"),
    });
    const result = await driver.compose({
      ...withOutput("/tmp/render-test-held.mp4"),
      characterOverlay: overlayWithHolds([{ atFrame: 3, frames: 2, seconds: 5 }]),
    });
    expect(result.ok).toBe(true);

    const calls = readRecordedArgv();
    // Two ffmpeg invocations: the derivation, then the render.
    expect(calls).toHaveLength(2);
    const [derive, render] = calls;
    expect(derive).toContain("loop=loop=30:size=2:start=3");
    expect(derive).toContain("ffv1");
    expect(derive.at(-1)?.endsWith("character-held.mkv")).toBe(true);

    // The render loops the derived file. `-ignore_loop` is the GIF
    // demuxer's flag and does not apply to a Matroska input.
    expect(render).toContain("-stream_loop");
    expect(render).not.toContain("-ignore_loop");
    expect(render.some((arg) => arg.endsWith("character-held.mkv"))).toBe(true);
    expect(render).not.toContain("/tmp/character.gif");
  });

  it("feeds the asset straight to the render when she has no holds", async () => {
    const driver = new FfmpegRenderDriver({
      ffmpegBin: fixture("fake-ffmpeg-record-argv.py"),
      ffprobeBin: fixture("fake-ffprobe-success.py"),
    });
    const result = await driver.compose({
      ...withOutput("/tmp/render-test-unheld.mp4"),
      characterOverlay: overlayWithHolds([]),
    });
    expect(result.ok).toBe(true);

    const calls = readRecordedArgv();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("-ignore_loop");
    expect(calls[0]).toContain("/tmp/character.gif");
  });

  it("fails the render when the hold spec does not fit the asset", async () => {
    const driver = new FfmpegRenderDriver({
      ffmpegBin: fixture("fake-ffmpeg-record-argv.py"),
      ffprobeBin: fixture("fake-ffprobe-success.py"),
    });
    // The fixture's loop is 70 frames long.
    const result = await driver.compose({
      ...withOutput("/tmp/render-test-never-written.mp4"),
      characterOverlay: overlayWithHolds([{ atFrame: 200, frames: 1, seconds: 5 }]),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("invalid_response");
      expect(result.error.retryable).toBe(false);
    }
  });
});
