import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { FfmpegRenderDriver, buildFilterGraph } from "./render-ffmpeg.ts";

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

describe("buildFilterGraph", () => {
  const assPath = "/tmp/captions.ass";

  it("skips concat for a single footage clip", () => {
    const graph = buildFilterGraph({ assPath, footageClipCount: 1 });
    expect(graph).not.toContain("concat");
    expect(graph).toContain("ass=");
  });

  it("concatenates a montage into one stream before burning captions on it", () => {
    const graph = buildFilterGraph({ assPath, footageClipCount: 3 });
    expect(graph).toContain("concat=n=3:v=1:a=0[fg]");
    expect(graph.indexOf("concat=")).toBeLessThan(graph.indexOf("ass="));
    expect(graph.endsWith("[v]")).toBe(true);
  });

  /**
   * The host moved to its own pass over the finished video on 2026-09-03
   * (operator direction), so nothing in this graph composites a character.
   * Asserted rather than assumed: an overlay left here would put the host
   * *under* the captions and quietly undo the whole point of the split.
   */
  it("composites no host at all — that is a separate pass now", () => {
    const graph = buildFilterGraph({ assPath, footageClipCount: 2 });
    expect(graph).not.toContain("overlay=");
    expect(graph).not.toContain("yuva420p");
    expect(graph).not.toContain("colorkey");
    expect(graph).toContain("concat=n=2");
  });

  it("maps only the footage clips and the narration, so no input is left unaccounted for", async () => {
    const driver = new FfmpegRenderDriver({
      ffmpegBin: fixture("fake-ffmpeg-record-argv.py"),
      ffprobeBin: fixture("fake-ffprobe-success.py"),
    });
    const result = await driver.compose(withOutput("/tmp/render-test-nohost.mp4"));
    expect(result.ok).toBe(true);

    const argv = readRecordedArgv()[0];
    // One footage clip at index 0, narration at index 1 — and no pack MOV
    // anywhere in the argument list.
    expect(argv).toContain("1:a");
    expect(argv.some((arg) => arg.endsWith(".mov"))).toBe(false);
  });
});
