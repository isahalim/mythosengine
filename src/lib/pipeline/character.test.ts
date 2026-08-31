import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHARACTER_ASSET_PATH, CHARACTER_OVERLAY, resolveCharacterOverlay } from "./character.ts";
import { buildFilterGraph } from "../drivers/render-ffmpeg.ts";

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
    expect(graph).toBe("[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,ass=/tmp/c.ass[v]");
    expect(graph).not.toContain("overlay");
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
