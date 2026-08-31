import { execSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractClip, trimHeadTail } from "./clip.ts";

function hasFfmpeg(): boolean {
  try {
    execSync("which ffmpeg", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("extractClip", () => {
  let dir: string;
  let sourcePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "clip-test-"));
    sourcePath = join(dir, "source.mp4");
    if (hasFfmpeg()) {
      execSync(
        `ffmpeg -y -f lavfi -i "testsrc=duration=6:size=320x240:rate=15" -c:v libx264 -pix_fmt yuv420p "${sourcePath}"`,
        { stdio: "ignore" },
      );
    }
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.skipIf(!hasFfmpeg())("extracts a real sub-clip at the requested duration", async () => {
    const outputPath = join(dir, "clip.mp4");
    const result = await extractClip(sourcePath, 1, 2, outputPath);
    expect(result.ok).toBe(true);

    const durationOut = execSync(
      `ffprobe -v quiet -print_format json -show_format "${outputPath}"`,
    ).toString();
    const duration = Number(JSON.parse(durationOut).format.duration);
    expect(duration).toBeGreaterThan(1.5);
    expect(duration).toBeLessThan(2.5);
  });

  it("fails with a non-retryable provider_error when ffmpeg can't be found", async () => {
    const result = await extractClip(sourcePath, 0, 1, join(dir, "out.mp4"), {
      ffmpegBin: "definitely-not-a-real-binary-xyz",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("provider_error");
      expect(result.error.retryable).toBe(false);
    }
  });

  it.skipIf(!hasFfmpeg())("reports a retryable error when the source file doesn't exist", async () => {
    const result = await extractClip(join(dir, "does-not-exist.mp4"), 0, 1, join(dir, "out.mp4"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.retryable).toBe(true);
  });
});

describe("trimHeadTail", () => {
  let dir: string;
  let sourcePath: string;

  /**
   * A colour-coded stand-in for a walkthrough episode: red intro, green
   * body, blue outro, with a keyframe every second so a stream-copy trim can
   * actually land near where it was asked to. Solid colours are what make
   * the assertion below possible — scaling any frame of a solid-colour
   * segment to 1x1 gives back exactly that colour, so "which part of the
   * source is this frame from" is readable from three bytes, with no image
   * library and no OCR.
   */
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "trim-test-"));
    sourcePath = join(dir, "source.mp4");
    if (hasFfmpeg()) {
      execSync(
        `ffmpeg -y ` +
          `-f lavfi -i "color=c=red:duration=2:size=320x240:rate=15" ` +
          `-f lavfi -i "color=c=green:duration=4:size=320x240:rate=15" ` +
          `-f lavfi -i "color=c=blue:duration=2:size=320x240:rate=15" ` +
          `-filter_complex "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]" -map "[v]" ` +
          `-c:v libx264 -pix_fmt yuv420p -force_key_frames "expr:gte(t,n_forced*1)" "${sourcePath}"`,
        { stdio: "ignore" },
      );
    }
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** The average colour of one frame, as [r,g,b], read straight out of ffmpeg. */
  function frameColour(path: string, atS: number): [number, number, number] {
    const raw = execSync(
      `ffmpeg -v quiet -ss ${atS} -i "${path}" -frames:v 1 -vf scale=1:1 -f rawvideo -pix_fmt rgb24 -`,
      { maxBuffer: 1024 },
    );
    return [raw[0], raw[1], raw[2]];
  }

  const dominant = ([r, g, b]: [number, number, number]): "red" | "green" | "blue" =>
    r >= g && r >= b ? "red" : g >= b ? "green" : "blue";

  it.skipIf(!hasFfmpeg())("drops the head and the tail, keeping only the middle", async () => {
    const outputPath = join(dir, "body.mp4");
    const result = await trimHeadTail(sourcePath, 8, 2, outputPath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.keptFromS).toBe(2);
    expect(result.value.keptDurationS).toBe(4);

    // Both ends of what survived are body, not intro and not outro — this is
    // the assertion the operator directive is actually about.
    expect(dominant(frameColour(outputPath, 0))).toBe("green");
    expect(dominant(frameColour(outputPath, 3.5))).toBe("green");
  });

  it.skipIf(!hasFfmpeg())("refuses a source too short to survive both cuts, rather than emitting an empty file", async () => {
    const outputPath = join(dir, "body.mp4");
    const result = await trimHeadTail(sourcePath, 8, 5, outputPath);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("policy_violation");
      expect(result.error.retryable).toBe(false);
    }
  });

  it("fails with a non-retryable provider_error when ffmpeg can't be found", async () => {
    const result = await trimHeadTail(sourcePath, 8, 2, join(dir, "body.mp4"), {
      ffmpegBin: "definitely-not-a-real-binary-xyz",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("provider_error");
      expect(result.error.retryable).toBe(false);
    }
  });
});
