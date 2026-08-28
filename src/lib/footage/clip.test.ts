import { execSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractClip } from "./clip.ts";

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
