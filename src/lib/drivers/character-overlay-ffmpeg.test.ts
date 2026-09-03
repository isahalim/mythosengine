import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { FfmpegCharacterOverlayDriver, buildConcatList, buildOverlayGraph } from "./character-overlay-ffmpeg.ts";
import type { CharacterClip } from "./types.ts";

const fixturesDir = join(import.meta.dirname, "__fixtures__");
const fixture = (name: string) => join(fixturesDir, name);

// Where fake-ffmpeg-record-argv.py appends each invocation it sees.
const argvLog = join(mkdtempSync(join(tmpdir(), "host-argv-")), "argv.jsonl");
process.env.FFMPEG_ARGV_LOG = argvLog;

function readRecordedArgv(): string[][] {
  return readFileSync(argvLog, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as string[]);
}

function action(actionId: string, durationS: number, naturalDurationS = durationS): CharacterClip {
  return { filePath: `/tmp/pack/mov/${actionId}.mov`, actionId, durationS, naturalDurationS };
}

const baseRequest = {
  videoPath: "/tmp/finished.mp4",
  overlay: {
    clips: [action("wave_hello_intro", 3), action("talk_neutral_loop", 2.5), action("wave_goodbye_outro", 3)],
    heightRatio: 0.34,
    bottomMarginRatio: 0.1,
  },
  outputPath: "/tmp/with-host.mp4",
  durationS: 8.5,
};

beforeEach(() => {
  rmSync(argvLog, { force: true });
});

describe("FfmpegCharacterOverlayDriver", () => {
  it("composites in one pass with two inputs, however many actions the track has", async () => {
    // The reason the deterministic cycle is affordable: a 128s video is ~44
    // actions, and as `-i` arguments that would be 44 concurrent decodes of
    // lossless RGBA on the operator's own machine.
    const driver = new FfmpegCharacterOverlayDriver({ ffmpegBin: fixture("fake-ffmpeg-record-argv.py") });
    const result = await driver.composite(baseRequest);
    expect(result.ok).toBe(true);

    const calls = readRecordedArgv();
    expect(calls).toHaveLength(1);
    const argv = calls[0];
    expect(argv.filter((arg) => arg === "-i")).toHaveLength(2);
    expect(argv).toContain("/tmp/finished.mp4");
    expect(argv).toContain("concat");
    // No pack MOV is ever an ffmpeg argument — they are all inside the list.
    expect(argv.some((arg) => arg.endsWith(".mov"))).toBe(false);
  });

  it("passes -safe 0 before the list, or ffmpeg refuses every absolute path in it", async () => {
    const driver = new FfmpegCharacterOverlayDriver({ ffmpegBin: fixture("fake-ffmpeg-record-argv.py") });
    await driver.composite(baseRequest);

    const argv = readRecordedArgv()[0];
    const concatAt = argv.indexOf("concat");
    const safeAt = argv.indexOf("-safe");
    // Demuxer options are INPUT options: after `-f concat`, before the `-i`.
    expect(safeAt).toBeGreaterThan(concatAt);
    expect(argv[safeAt + 1]).toBe("0");
    expect(argv[safeAt + 2]).toBe("-i");
  });

  it("copies the audio rather than re-encoding it", async () => {
    // The narration is already AAC from the render pass. This second encode
    // costs the picture one generation and the audio nothing.
    const driver = new FfmpegCharacterOverlayDriver({ ffmpegBin: fixture("fake-ffmpeg-record-argv.py") });
    await driver.composite(baseRequest);

    const argv = readRecordedArgv()[0];
    expect(argv[argv.indexOf("-c:a") + 1]).toBe("copy");
    expect(argv).toContain("0:a");
  });

  it("cuts the output at the finished video's length, because the host track runs past it", async () => {
    const driver = new FfmpegCharacterOverlayDriver({ ffmpegBin: fixture("fake-ffmpeg-record-argv.py") });
    await driver.composite(baseRequest);

    const argv = readRecordedArgv()[0];
    expect(argv[argv.indexOf("-t") + 1]).toBe("8.500");
  });

  it("reports an encoder failure instead of pretending the host is in the file", async () => {
    const driver = new FfmpegCharacterOverlayDriver({ ffmpegBin: fixture("fake-ffmpeg-fail.py") });
    const result = await driver.composite(baseRequest);
    expect(result.ok).toBe(false);
    // The caller degrades on this — the finished no-host video is still a
    // publishable Short — but it can only do that if it is told.
    if (!result.ok) expect(result.error.kind).toBe("provider_error");
  });

  it("fails non-retryably when ffmpeg itself cannot be found", async () => {
    const driver = new FfmpegCharacterOverlayDriver({ ffmpegBin: "definitely-not-a-real-binary-xyz" });
    const result = await driver.composite(baseRequest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("provider_error");
      expect(result.error.retryable).toBe(false);
    }
  });

  it("refuses an empty track rather than writing a concat list with no entries", async () => {
    const driver = new FfmpegCharacterOverlayDriver({ ffmpegBin: fixture("fake-ffmpeg-fail.py") });
    const result = await driver.composite({ ...baseRequest, overlay: { ...baseRequest.overlay, clips: [] } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("invalid_response");
      expect(result.error.message).toContain("skip this pass entirely");
    }
  });

  it("refuses a missing duration rather than producing a video as long as the overshoot", async () => {
    const driver = new FfmpegCharacterOverlayDriver({ ffmpegBin: fixture("fake-ffmpeg-fail.py") });
    const result = await driver.composite({ ...baseRequest, durationS: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid_response");
  });
});

describe("buildConcatList", () => {
  it("names every action in order, once each", () => {
    const list = buildConcatList([action("a", 3), action("b", 2.5), action("a", 3)]);
    expect(list.startsWith("ffconcat version 1.0\n")).toBe(true);
    expect(list.match(/^file /gm)).toHaveLength(3);
    expect(list.indexOf("/b.mov")).toBeGreaterThan(list.indexOf("/a.mov"));
  });

  it("writes an outpoint only for an action that is actually trimmed", () => {
    // An outpoint on a whole clip depends on the manifest's duration_ms
    // agreeing with the container to the millisecond, and where it rounds
    // short it silently drops the action's last frame.
    const list = buildConcatList([action("whole", 3), action("trimmed", 1.25, 3.5)]);
    expect(list.match(/^outpoint /gm)).toHaveLength(1);
    expect(list).toContain("outpoint 1.250");
  });

  it("escapes a quote in a path rather than ending the quoting early", () => {
    // A repository under a home directory with an apostrophe in its name is
    // not hypothetical, and the failure is ffmpeg reading a truncated path.
    const list = buildConcatList([{ filePath: "/Users/o'brien/pack/a.mov", actionId: "a", durationS: 3, naturalDurationS: 3 }]);
    expect(list).toContain(`file '/Users/o'\\''brien/pack/a.mov'`);
  });
});

describe("buildOverlayGraph", () => {
  it("carries the pack's alpha through, and keys nothing", () => {
    const graph = buildOverlayGraph({ heightRatio: 0.34, bottomMarginRatio: 0.1 });
    // yuva420p, not yuv420p: dropping the alpha plane flattens the host onto
    // a black rectangle, which is the one mistake here that still encodes.
    expect(graph).toContain("yuva420p");
    expect(graph).not.toContain("colorkey");
    expect(graph).not.toContain("chromakey");
  });

  it("floats the host clear of the bottom edge rather than planting it on the floor", () => {
    const graph = buildOverlayGraph({ heightRatio: 0.34, bottomMarginRatio: 0.1, outputHeight: 1920 });
    expect(graph).toContain("overlay=(W-w)/2:H-h-192");
    // -1 preserves each action's aspect ratio from the pack's 640x680 canvas.
    expect(graph).toContain("scale=-1:653");
  });

  it("never lets the host truncate the video", () => {
    expect(buildOverlayGraph({ heightRatio: 0.34, bottomMarginRatio: 0.1 })).toContain("shortest=0");
  });

  it("puts the finished video under the host, not the other way round", () => {
    // Input 0 is the render, input 1 is the track. Swapping them composites
    // a 1080x1920 video over a 640-wide robot.
    const graph = buildOverlayGraph({ heightRatio: 0.34, bottomMarginRatio: 0.1 });
    expect(graph).toContain("[1:v]scale=");
    expect(graph).toContain("[0:v][ch]overlay=");
  });
});
