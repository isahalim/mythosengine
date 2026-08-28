import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeMotionSeries, findTopMotionWindows, parseSignalstatsOutput } from "./motion-score.ts";

const fixturesDir = join(import.meta.dirname, "__fixtures__");
const fixture = (name: string) => join(fixturesDir, name);

describe("parseSignalstatsOutput", () => {
  it("parses a real ffmpeg signalstats+metadata=print sample", () => {
    const text = readFileSync(join(fixturesDir, "real-signalstats-sample.txt"), "utf8");
    const samples = parseSignalstatsOutput(text);
    expect(samples.length).toBeGreaterThan(0);
    expect(samples[0].ptsTimeS).toBe(0);
    expect(samples[0].motion).toBe(0); // no prior frame to diff against
    expect(samples[1].motion).toBeGreaterThan(0);
  });

  it("returns an empty array for text with no frame blocks", () => {
    expect(parseSignalstatsOutput("nothing useful here")).toEqual([]);
  });

  it("treats a missing DIF field as zero motion rather than NaN", () => {
    const samples = parseSignalstatsOutput("frame:0 pts:0 pts_time:0\nlavfi.signalstats.YMIN=1\n");
    expect(samples).toEqual([{ ptsTimeS: 0, motion: 0 }]);
  });
});

describe("findTopMotionWindows", () => {
  it("finds the single window covering the highest-motion segment", () => {
    const series = Array.from({ length: 30 }, (_, i) => ({
      ptsTimeS: i,
      motion: i >= 10 && i < 15 ? 100 : 1, // a clear spike at t=10-14
    }));
    const windows = findTopMotionWindows(series, 5, 1);
    expect(windows).toHaveLength(1);
    expect(windows[0].startS).toBe(10);
  });

  it("returns non-overlapping windows for topK > 1", () => {
    const series = Array.from({ length: 60 }, (_, i) => ({
      ptsTimeS: i,
      motion: (i >= 5 && i < 10) || (i >= 40 && i < 45) ? 100 : 1,
    }));
    const windows = findTopMotionWindows(series, 5, 2);
    expect(windows).toHaveLength(2);
    const gap = Math.abs(windows[0].startS - windows[1].startS);
    expect(gap).toBeGreaterThanOrEqual(5);
  });

  it("returns an empty array for an empty series", () => {
    expect(findTopMotionWindows([], 5, 3)).toEqual([]);
  });

  it("returns fewer than topK windows when the video is shorter than topK non-overlapping windows would need", () => {
    const series = Array.from({ length: 8 }, (_, i) => ({ ptsTimeS: i, motion: 1 }));
    const windows = findTopMotionWindows(series, 5, 5);
    expect(windows.length).toBeLessThan(5);
  });
});

describe("computeMotionSeries error handling", () => {
  it("fails with a non-retryable provider_error when ffmpeg can't be found", async () => {
    const result = await computeMotionSeries("/tmp/whatever.mp4", { ffmpegBin: "definitely-not-a-real-binary-xyz" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("provider_error");
      expect(result.error.retryable).toBe(false);
    }
  });

  it("fails with a retryable invalid_response when ffmpeg exits cleanly but writes no stats file", async () => {
    const result = await computeMotionSeries("/tmp/whatever.mp4", { ffmpegBin: fixture("fake-ffmpeg-exit-clean-no-file.py") });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("invalid_response");
      expect(result.error.retryable).toBe(true);
    }
  });
});

describe("computeMotionSeries (real ffmpeg)", () => {
  it("produces a real, non-trivial motion series from a real video file", async () => {
    // Generated locally with: ffmpeg -f lavfi -i testsrc=duration=8:size=1280x720:rate=30 ...
    // Not committed as a binary fixture -- regenerate if this test needs to run
    // without network/ffmpeg access; skipped gracefully if ffmpeg isn't present.
    const { execSync } = await import("node:child_process");
    try {
      execSync("which ffmpeg", { stdio: "ignore" });
    } catch {
      return; // no ffmpeg on this machine -- covered by the fixture-based unit tests above
    }

    const { mkdtempSync, rmSync } = await import("node:fs");
    const dir = mkdtempSync(join(await import("node:os").then((m) => m.tmpdir()), "motion-test-"));
    const videoPath = join(dir, "test.mp4");
    execSync(
      `ffmpeg -y -f lavfi -i "testsrc=duration=6:size=320x240:rate=15" -c:v libx264 -pix_fmt yuv420p "${videoPath}"`,
      { stdio: "ignore" },
    );

    const result = await computeMotionSeries(videoPath);
    rmSync(dir, { recursive: true, force: true });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBeGreaterThan(3);
      expect(result.value.some((s) => s.motion > 0)).toBe(true);
    }
  }, 30_000);
});
