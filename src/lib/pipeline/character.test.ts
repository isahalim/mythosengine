import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHARACTER_BOTTOM_MARGIN_RATIO, CHARACTER_HEIGHT_RATIO, resolveCharacterPack } from "./character.ts";
import { actionSequence, clipPath, loadCharacterPack } from "./character-pack.ts";
import { buildCharacterTimeline } from "./character-timeline.ts";

const REPO_DIR = process.cwd();

/**
 * The real pack, not a fixture.
 *
 * The whole point of this module is that the manifest — a committed asset —
 * is the source of truth for what the host can do. A test against a
 * hand-written fixture manifest would pass while the real one was malformed,
 * which is precisely the failure it should catch.
 */
const pack = loadCharacterPack(REPO_DIR);

/** A minimal well-formed pack on disk, for the cases that need a *broken* one. */
function writePack(manifest: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "char-pack-"));
  mkdirSync(join(dir, "pack"), { recursive: true });
  writeFileSync(join(dir, "pack", "manifest.json"), JSON.stringify(manifest), "utf8");
  return dir;
}

describe("the robot character pack", () => {
  it("carries the 19 actions the pipeline plans against", () => {
    expect(pack.clips).toHaveLength(19);
    expect(pack.pack).toBe("robot_host_character");
  });

  it("names defaults that actually exist in its own clip list", () => {
    // A manifest whose default points at a missing clip fails every render
    // at encode time, one file lookup too late.
    expect(pack.byId.has(pack.defaults.speaking)).toBe(true);
    expect(pack.byId.has(pack.defaults.silent)).toBe(true);
  });

  it("resolves every action to an alpha MOV, never the 1-bit GIF", () => {
    for (const clip of pack.clips) {
      expect(clipPath(pack, clip.id).endsWith(".mov")).toBe(true);
    }
  });

  it("throws on an unknown action rather than returning a path nothing can read", () => {
    expect(() => clipPath(pack, "talk_shrug_loop")).toThrow(/no action/);
  });
});

describe("actionSequence", () => {
  it("finds its own waves by category rather than by hard-coded id", () => {
    const { intro, outro } = actionSequence(pack);
    expect(intro?.id).toBe("wave_hello_intro");
    expect(outro?.id).toBe("wave_goodbye_outro");
  });

  it("puts every other action in the cycle, in the manifest's own order", () => {
    const { intro, middle, outro } = actionSequence(pack);
    // 19 clips, two of them waves.
    expect(middle).toHaveLength(17);
    expect(middle.map((a) => a.id)).not.toContain(intro?.id);
    expect(middle.map((a) => a.id)).not.toContain(outro?.id);
    // Manifest order, not sorted or shuffled: the pack lists its talking
    // clips before its reactions, and cycling that order is what makes the
    // performance read as a presenter rather than a shuffle.
    expect(middle[0].id).toBe("talk_neutral_loop");
    expect(middle[middle.length - 1].id).toBe("laugh_happy_loop");
  });

  it("carries each action's own duration in seconds, from the manifest", () => {
    const { intro, middle } = actionSequence(pack);
    expect(intro?.durationS).toBe(3);
    expect(middle.find((a) => a.id === "thinking_hand_on_chin_loop")?.durationS).toBe(4);
  });

  it("runs everything it has when a pack is nothing but waves", () => {
    // Degenerate, but the alternative is a two-clip track under a
    // two-minute video and a presenter who vanishes after six seconds.
    const onlyWaves = {
      ...pack,
      clips: pack.clips.filter((clip) => clip.category === "transition"),
    };
    expect(actionSequence(onlyWaves).middle).toHaveLength(2);
  });
});

describe("resolveCharacterPack", () => {
  it("resolves the committed pack", async () => {
    const resolution = await resolveCharacterPack(REPO_DIR);
    expect(resolution.present).toBe(true);
  });

  it("degrades to a hostless render rather than failing when the pack is missing", async () => {
    const resolution = await resolveCharacterPack(REPO_DIR, join("assets", "character", "not_a_pack"));
    expect(resolution.present).toBe(false);
    // Never silent: "why is she not in this one" is not answerable from the
    // video, so the reason reaches the audit package.
    if (!resolution.present) expect(resolution.reason).toContain("manifest.json");
  });

  it("degrades rather than throwing when the manifest is malformed", async () => {
    const dir = writePack({ pack: "broken" });
    try {
      const resolution = await resolveCharacterPack(dir, "pack");
      expect(resolution.present).toBe(false);
      if (!resolution.present) expect(resolution.reason).toContain("could not be read");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the host clear of the caption band", () => {
    // The captions sit at 8% from the bottom; the host floats above them.
    expect(CHARACTER_BOTTOM_MARGIN_RATIO).toBeGreaterThan(0.08);
    expect(CHARACTER_HEIGHT_RATIO + CHARACTER_BOTTOM_MARGIN_RATIO).toBeLessThan(1);
  });
});

describe("buildCharacterTimeline", () => {
  const { intro, middle, outro } = actionSequence(pack);
  const CYCLE_S = middle.reduce((total, action) => total + action.durationS, 0);

  it("opens on the hello wave and closes on the goodbye, every time", () => {
    // The one rule this stage has (operator direction, 2026-09-03).
    for (const videoDurationS of [12, 47, 128, 180]) {
      const { clips } = buildCharacterTimeline({ pack, videoDurationS });
      expect(clips[0].actionId).toBe("wave_hello_intro");
      expect(clips[clips.length - 1].actionId).toBe("wave_goodbye_outro");
    }
  });

  it("runs the pack's actions in manifest order between the waves", () => {
    const { clips } = buildCharacterTimeline({ pack, videoDurationS: 60 });
    const between = clips.slice(1, -1).map((clip) => clip.actionId);
    expect(between.slice(0, 4)).toEqual(middle.slice(0, 4).map((a) => a.id));
  });

  it("loops the cycle rather than stopping at the end of the pack", () => {
    // 3s hello + 50.5s of cycle + 3s goodbye is 56.5s, so a 128s video needs
    // the cycle more than twice. A track that stopped after one pass would
    // leave the host frozen for over a minute.
    const { clips } = buildCharacterTimeline({ pack, videoDurationS: 128 });
    const played = clips.slice(1, -1).map((clip) => clip.actionId);
    expect(played.length).toBeGreaterThan(middle.length);
    expect(played[0]).toBe(played[middle.length]);
  });

  it("covers the whole video and never stops short of it", () => {
    // The asymmetry that matters: an overshoot costs the goodbye wave part
    // of its tail, an undershoot costs the last moment its host entirely.
    for (const videoDurationS of [1, 5, 12.34, 47, 60, 128, 179.9]) {
      const { trackDurationS } = buildCharacterTimeline({ pack, videoDurationS });
      expect(trackDurationS).toBeGreaterThanOrEqual(videoDurationS);
    }
  });

  it("overshoots by less than one action, so the wave is only ever clipped", () => {
    for (const videoDurationS of [47, 60, 128, 179.9]) {
      const { trackDurationS } = buildCharacterTimeline({ pack, videoDurationS });
      // Well inside the 3s goodbye, so what survives still reads as a wave.
      expect(trackDurationS - videoDurationS).toBeLessThan(1);
    }
  });

  it("plays every action for its own length, never stretched", () => {
    // The concat demuxer can cut an entry short but cannot loop one, so a
    // durationS above the file's length is not a thing the encoder can honour.
    const { clips } = buildCharacterTimeline({ pack, videoDurationS: 128 });
    for (const clip of clips) expect(clip.durationS).toBeLessThanOrEqual(clip.naturalDurationS);
  });

  it("trims at most one action, and only to land the goodbye on the end", () => {
    const { clips } = buildCharacterTimeline({ pack, videoDurationS: 128 });
    const trimmed = clips.filter((clip) => clip.durationS < clip.naturalDurationS);
    expect(trimmed.length).toBeLessThanOrEqual(1);
    // Never the wave, and never mid-track.
    if (trimmed.length === 1) expect(clips.indexOf(trimmed[0])).toBe(clips.length - 2);
  });

  it("never flashes an action too short to read", () => {
    // A remainder of 0.2s is played as 0.8s and the encoder takes the
    // difference off the end of the wave. Ten frames at the pack's 12fps.
    for (let videoDurationS = 57; videoDurationS < 61; videoDurationS += 0.1) {
      const { clips } = buildCharacterTimeline({ pack, videoDurationS });
      for (const clip of clips) expect(clip.durationS).toBeGreaterThanOrEqual(0.8);
    }
  });

  it("still waves at both ends of a video too short to hold one cycle", () => {
    // 4 seconds cannot fit a 3s hello and a 3s goodbye. The encoder's `-t`
    // cuts the track; it must still be a greeting and a sign-off.
    const { clips } = buildCharacterTimeline({ pack, videoDurationS: 4 });
    expect(clips.map((c) => c.actionId)).toEqual(["wave_hello_intro", "wave_goodbye_outro"]);
  });

  it("is a pure function of the pack and the duration", () => {
    // Nothing random, nothing time-dependent, no model: two calls with the
    // same duration are the same performance.
    const a = buildCharacterTimeline({ pack, videoDurationS: 93.7 });
    const b = buildCharacterTimeline({ pack, videoDurationS: 93.7 });
    expect(a).toEqual(b);
  });

  it("returns no track for a video with no duration, rather than throwing", () => {
    expect(buildCharacterTimeline({ pack, videoDurationS: 0 }).clips).toEqual([]);
    expect(buildCharacterTimeline({ pack, videoDurationS: Number.NaN }).clips).toEqual([]);
  });

  it("resolves every action to a real file in the pack", () => {
    const { clips } = buildCharacterTimeline({ pack, videoDurationS: 128 });
    for (const clip of clips) expect(clip.filePath).toBe(clipPath(pack, clip.actionId));
  });

  it("has a cycle worth looping — the sanity check behind the numbers above", () => {
    expect(CYCLE_S).toBeCloseTo(50.5, 1);
    expect(intro?.durationS).toBe(3);
    expect(outro?.durationS).toBe(3);
  });
});
