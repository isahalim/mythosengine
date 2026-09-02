import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { FfmpegRenderDriver, buildFilterGraph } from "./render-ffmpeg.ts";
import type { CharacterOverlay } from "./types.ts";

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

const overlay = (actionIds: string[]): CharacterOverlay => ({
  clips: actionIds.map((actionId, i) => ({ filePath: `/tmp/pack/${actionId}.mov`, actionId, durationS: 4 + i })),
  heightRatio: 0.34,
  bottomMarginRatio: 0.1,
});

describe("FfmpegRenderDriver character track", () => {
  it("feeds every action as its own looped, length-capped input", async () => {
    const driver = new FfmpegRenderDriver({
      ffmpegBin: fixture("fake-ffmpeg-record-argv.py"),
      ffprobeBin: fixture("fake-ffprobe-success.py"),
    });
    const result = await driver.compose({
      ...withOutput("/tmp/render-test-track.mp4"),
      characterOverlay: overlay(["talk_neutral_loop", "surprised_reaction"]),
    });
    expect(result.ok).toBe(true);

    // One invocation, not two. The old host needed a separate ffmpeg pass to
    // bake hand-counted frame holds into a derived file; cutting between real
    // actions needs no derivation at all.
    const calls = readRecordedArgv();
    expect(calls).toHaveLength(1);
    const argv = calls[0];

    expect(argv).toContain("/tmp/pack/talk_neutral_loop.mov");
    expect(argv).toContain("/tmp/pack/surprised_reaction.mov");
    // Each action loops to fill its scene and is cut to that scene's length.
    expect(argv).toContain("4.000");
    expect(argv).toContain("5.000");
    // The GIF demuxer's flag has no place here: the pack ships MOVs.
    expect(argv).not.toContain("-ignore_loop");
  });

  it("never chroma-keys, because the pack carries a real alpha channel", async () => {
    const driver = new FfmpegRenderDriver({
      ffmpegBin: fixture("fake-ffmpeg-record-argv.py"),
      ffprobeBin: fixture("fake-ffprobe-success.py"),
    });
    await driver.compose({ ...withOutput("/tmp/render-test-alpha.mp4"), characterOverlay: overlay(["talk_neutral_loop"]) });
    const graph = readRecordedArgv()[0].join(" ");
    expect(graph).not.toContain("colorkey");
    expect(graph).not.toContain("chromakey");
    // yuva420p, not yuv420p: dropping the alpha plane is the one mistake in
    // this graph that still encodes successfully, flattening the host onto a
    // black rectangle.
    expect(graph).toContain("yuva420p");
  });

  it("refuses an overlay declared with no actions rather than building an empty concat", async () => {
    const driver = new FfmpegRenderDriver({ ffmpegBin: fixture("fake-ffmpeg-fail.py") });
    const result = await driver.compose({
      ...withOutput("/tmp/render-test-never-written.mp4"),
      characterOverlay: { clips: [], heightRatio: 0.34, bottomMarginRatio: 0.1 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("invalid_response");
      expect(result.error.message).toContain("omit it entirely");
    }
  });
});

describe("buildFilterGraph", () => {
  const assPath = "/tmp/captions.ass";

  it("skips concat for a single footage clip and a single action", () => {
    const graph = buildFilterGraph({ assPath, footageClipCount: 1, character: { clipCount: 1, heightRatio: 0.34, bottomMarginRatio: 0.1 } });
    expect(graph).not.toContain("concat");
    expect(graph).toContain("overlay=");
  });

  it("concatenates both tracks independently when each has several clips", () => {
    const graph = buildFilterGraph({ assPath, footageClipCount: 3, character: { clipCount: 3, heightRatio: 0.34, bottomMarginRatio: 0.1 } });
    expect(graph).toContain("concat=n=3:v=1:a=0[fg]");
    expect(graph).toContain("concat=n=3:v=1:a=0[ch]");
  });

  it("numbers the host's inputs after the footage clips and the narration", () => {
    // Footage occupies 0..1, narration is 2, so the host starts at 3. Getting
    // this wrong composites the narration's (non-existent) video or a footage
    // clip over itself.
    const graph = buildFilterGraph({ assPath, footageClipCount: 2, character: { clipCount: 2, heightRatio: 0.34, bottomMarginRatio: 0.1 } });
    expect(graph).toContain("[3:v]");
    expect(graph).toContain("[4:v]");
  });

  it("burns the captions last so the host can never cover a word", () => {
    const graph = buildFilterGraph({ assPath, footageClipCount: 1, character: { clipCount: 2, heightRatio: 0.34, bottomMarginRatio: 0.1 } });
    expect(graph.indexOf("overlay=")).toBeLessThan(graph.indexOf("ass="));
    expect(graph.endsWith("[v]")).toBe(true);
  });

  it("floats the host clear of the bottom edge rather than planting it on the floor", () => {
    const graph = buildFilterGraph({
      assPath,
      footageClipCount: 1,
      character: { clipCount: 1, heightRatio: 0.34, bottomMarginRatio: 0.1 },
      outputHeight: 1920,
    });
    expect(graph).toContain("overlay=(W-w)/2:H-h-192");
  });

  it("omits the host entirely when there is no character", () => {
    const graph = buildFilterGraph({ assPath, footageClipCount: 2 });
    expect(graph).not.toContain("overlay=");
    expect(graph).toContain("concat=n=2");
  });
});
