import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FfmpegRenderDriver } from "./render-ffmpeg.ts";

const fixturesDir = join(import.meta.dirname, "__fixtures__");
const fixture = (name: string) => join(fixturesDir, name);

const baseRequest = {
  footageClipPath: "/tmp/does-not-need-to-exist-for-the-fixture.mp4",
  narrationAudioPath: "/tmp/does-not-need-to-exist-for-the-fixture.mp3",
  captionCues: [{ text: "hello", startMs: 0, endMs: 500 }],
  outputPath: "",
};

function withOutput(outputPath: string) {
  return { ...baseRequest, outputPath };
}

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
