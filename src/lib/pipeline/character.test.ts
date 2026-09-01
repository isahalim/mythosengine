import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHARACTER_ASSET_PATH, CHARACTER_HOLDS, CHARACTER_OVERLAY, resolveCharacterOverlay } from "./character.ts";
import { buildFilterGraph, buildHoldFilter } from "../drivers/render-ffmpeg.ts";

describe("CHARACTER_OVERLAY", () => {
  it("keys at the measured ceiling, never above it", () => {
    // Plan v2 §2: 0.14 begins eating her face, 0.20 destroys it. This
    // assertion exists so raising the tolerance to chase a fringe fails a
    // test instead of quietly degrading every video.
    expect(CHARACTER_OVERLAY.similarity).toBeLessThanOrEqual(0.1);
    expect(CHARACTER_OVERLAY.keyColor).toBe("0xe5505c");
    expect(CHARACTER_OVERLAY.blend).toBe(0);
  });
});

describe("resolveCharacterOverlay", () => {
  it("returns an absolute path when the asset is present", async () => {
    const repo = await mkdtemp(join(tmpdir(), "character-"));
    await mkdir(dirname(join(repo, CHARACTER_ASSET_PATH)), { recursive: true });
    await writeFile(join(repo, CHARACTER_ASSET_PATH), "GIF89a");

    const result = await resolveCharacterOverlay(repo);
    expect(result.present).toBe(true);
    if (!result.present) throw new Error("expected present");
    expect(isAbsolute(result.overlay.filePath)).toBe(true);
    expect(result.overlay.similarity).toBe(CHARACTER_OVERLAY.similarity);
  });

  it("explains the absence rather than throwing, so the render still ships", async () => {
    const repo = await mkdtemp(join(tmpdir(), "character-"));
    const result = await resolveCharacterOverlay(repo);
    expect(result.present).toBe(false);
    if (result.present) throw new Error("expected absent");
    expect(result.reason).toContain(CHARACTER_ASSET_PATH);
    expect(result.reason).toContain("footage and captions only");
  });
});

describe("buildFilterGraph", () => {
  it("burns captions straight onto the framed footage when there is no character", () => {
    const graph = buildFilterGraph("/tmp/c.ass", undefined);
    expect(graph).toBe(
      "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30,format=yuv420p[fg];[fg]ass=/tmp/c.ass[v]",
    );
    expect(graph).not.toContain("overlay");
  });

  it("does not concat a single-clip footage track", () => {
    expect(buildFilterGraph("/tmp/c.ass", undefined, 1)).not.toContain("concat");
  });

  it("normalizes every clip and concatenates them for a montage", () => {
    const graph = buildFilterGraph("/tmp/c.ass", undefined, 3);
    // concat compares size, pixel format, frame rate and sample aspect
    // across its inputs and errors on any disagreement — which is exactly
    // what three clips from three photographers will do untouched.
    expect(graph).toContain("[0:v]scale=1080:1920");
    expect(graph).toContain("[1:v]scale=1080:1920");
    expect(graph).toContain("[2:v]scale=1080:1920");
    expect(graph.match(/fps=30,format=yuv420p/g)).toHaveLength(3);
    expect(graph).toContain("[c0][c1][c2]concat=n=3:v=1:a=0[fg]");
  });

  it("reads the character from the input after the clips and the narration, however many clips there are", () => {
    // 4 clips -> inputs 0-3 are footage, 4 is the narration, 5 is the host.
    // Getting this wrong composites the narration's cover art, or nothing.
    expect(buildFilterGraph("/tmp/c.ass", CHARACTER_OVERLAY, 4)).toContain("[5:v]scale=-1:");
    expect(buildFilterGraph("/tmp/c.ass", CHARACTER_OVERLAY, 1)).toContain("[2:v]scale=-1:");
  });

  it("still burns the captions last in a montage with a character", () => {
    const graph = buildFilterGraph("/tmp/c.ass", CHARACTER_OVERLAY, 3);
    expect(graph.indexOf("concat=")).toBeLessThan(graph.indexOf("overlay="));
    expect(graph.indexOf("overlay=")).toBeLessThan(graph.indexOf("ass="));
  });

  it("keys the character and composites her before the captions are burned in", () => {
    const graph = buildFilterGraph("/tmp/c.ass", CHARACTER_OVERLAY);
    // Captions last is the only order in which she cannot cover a word —
    // she is anchored bottom-centre, which is where the captions live.
    expect(graph.indexOf("overlay=")).toBeLessThan(graph.indexOf("ass="));
    expect(graph).toContain("colorkey=0xe5505c:0.1:0");
  });

  it("scales her to the configured share of the frame, preserving aspect ratio", () => {
    const graph = buildFilterGraph("/tmp/c.ass", { ...CHARACTER_OVERLAY, heightRatio: 0.5 });
    expect(graph).toContain("scale=-1:960");
  });

  it("anchors her bottom-centre", () => {
    expect(buildFilterGraph("/tmp/c.ass", CHARACTER_OVERLAY)).toContain("overlay=(W-w)/2:H-h:shortest=0");
  });

  it("never lets the character loop truncate the video — the narration decides the length", () => {
    expect(buildFilterGraph("/tmp/c.ass", CHARACTER_OVERLAY)).toContain("shortest=0");
  });

  it("escapes a caption path containing a colon, which ffmpeg's filter parser would otherwise split on", () => {
    expect(buildFilterGraph("/tmp/a:b.ass", CHARACTER_OVERLAY)).toContain("ass=/tmp/a\\:b.ass");
  });
});

describe("CHARACTER_HOLDS", () => {
  // The asset, measured: 70 frames at 12.5fps.
  const ASSET_FPS = 12.5;
  const ASSET_FRAMES = 70;

  it("holds where the operator asked, for as long as they asked", () => {
    expect(CHARACTER_HOLDS).toEqual([
      { atFrame: 3, frames: 2, seconds: 5 },
      { atFrame: 12, frames: 1, seconds: 5 },
      { atFrame: 28, frames: 1, seconds: 5 },
    ]);
  });

  it("cycles at frame 3 and freezes at 12 and 28", () => {
    // The distinction is the whole point of the first hold: a dead stop
    // three frames into the loop looks like the video stalled.
    const [first, ...rest] = CHARACTER_HOLDS;
    expect(first.frames).toBe(2);
    expect(rest.every((hold) => hold.frames === 1)).toBe(true);
  });

  it("fits the asset it was counted against", () => {
    // This is the guard on swapping the loop for a different one: every
    // hold has to land inside it, and none may overlap.
    const result = buildHoldFilter(CHARACTER_HOLDS, ASSET_FPS, ASSET_FRAMES);
    expect(result.ok).toBe(true);
  });

  it("stretches the 5.6s loop to about 20.5s", () => {
    // 70 frames + 62 + 62 + 60 extra = 254 frames at 12.5fps. She reaches
    // the end of her cycle roughly a quarter as often, which is the point.
    const added = CHARACTER_HOLDS.reduce((total, hold) => total + Math.round((hold.seconds * ASSET_FPS) / hold.frames) * hold.frames - hold.frames, 0);
    expect((ASSET_FRAMES + added) / ASSET_FPS).toBeCloseTo(20.32, 1);
  });

  it("is the spec the overlay actually carries", () => {
    expect(CHARACTER_OVERLAY.holds).toBe(CHARACTER_HOLDS);
  });
});
