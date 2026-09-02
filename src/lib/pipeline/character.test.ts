import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHARACTER_BOTTOM_MARGIN_RATIO, CHARACTER_HEIGHT_RATIO, resolveCharacterPack } from "./character.ts";
import { clipPath, describeActionsForPrompt, isKnownAction, loadCharacterPack, transitionIds } from "./character-pack.ts";
import { buildCharacterTimeline, defaultTrack } from "./character-timeline.ts";

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
    expect(isKnownAction(pack, pack.defaults.speaking)).toBe(true);
    expect(isKnownAction(pack, pack.defaults.silent)).toBe(true);
  });

  it("defaults to a talking action, because this show is continuous narration", () => {
    expect(pack.byId.get(pack.defaults.speaking)?.mouth_moving).toBe(true);
    expect(pack.byId.get(pack.defaults.silent)?.mouth_moving).toBe(false);
  });

  it("resolves every action to an alpha MOV, never the 1-bit GIF", () => {
    for (const clip of pack.clips) {
      expect(clipPath(pack, clip.id).endsWith(".mov")).toBe(true);
    }
  });

  it("finds its own intro and outro by category rather than by hard-coded id", () => {
    const { intro, outro } = transitionIds(pack);
    expect(intro).toBe("wave_hello_intro");
    expect(outro).toBe("wave_goodbye_outro");
  });

  it("describes every action for the prompt, so the model's vocabulary matches the pack", () => {
    const described = describeActionsForPrompt(pack);
    for (const clip of pack.clips) expect(described).toContain(clip.id);
  });

  it("throws on an unknown action rather than returning a path nothing can read", () => {
    expect(() => clipPath(pack, "talk_shrug_loop")).toThrow(/no action/);
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
  const scene = (position: number, actionId: string | null, durationS = 4) => ({ position, actionId, durationS });

  it("gives every composited shot exactly one action, spanning that shot", () => {
    const { clips } = buildCharacterTimeline({
      pack,
      scenes: [scene(0, "talk_neutral_loop", 3), scene(1, "talk_emphatic_loop", 5)],
    });
    expect(clips).toHaveLength(2);
    expect(clips.map((c) => c.durationS)).toEqual([3, 5]);
    expect(clips.map((c) => c.actionId)).toEqual(["talk_neutral_loop", "talk_emphatic_loop"]);
  });

  it("substitutes the pack default for an action the pack does not have", () => {
    const { clips, adjustments } = buildCharacterTimeline({ pack, scenes: [scene(0, "talk_backflip_loop")] });
    expect(clips[0].actionId).toBe(pack.defaults.speaking);
    // Recorded, not silently corrected: a model that keeps inventing ids
    // should be visible to a reviewer.
    expect(adjustments[0]).toContain("talk_backflip_loop");
  });

  it("fills in the default when PLAN chose nothing", () => {
    const { clips, adjustments } = buildCharacterTimeline({ pack, scenes: [scene(0, null)] });
    expect(clips[0].actionId).toBe(pack.defaults.speaking);
    expect(adjustments[0]).toContain("chose no action");
  });

  it("never chains two reactions", () => {
    // The pack's own rule, and the one whose violation reads most obviously
    // as a twitch rather than as a response to anything.
    const { clips, adjustments } = buildCharacterTimeline({
      pack,
      scenes: [scene(0, "surprised_reaction"), scene(1, "shrug_uncertain"), scene(2, "nod_yes_agree")],
    });
    expect(clips[0].actionId).toBe("surprised_reaction");
    expect(clips[1].actionId).toBe(pack.defaults.speaking);
    // The third is a reaction again, and legal — the one before it is no
    // longer a reaction, so nothing is being chained.
    expect(clips[2].actionId).toBe("nod_yes_agree");
    expect(adjustments.some((a) => a.includes("do not chain"))).toBe(true);
  });

  it("allows the greeting only on the opening shot", () => {
    const { clips, adjustments } = buildCharacterTimeline({
      pack,
      scenes: [scene(0, "wave_hello_intro"), scene(1, "wave_hello_intro")],
    });
    expect(clips[0].actionId).toBe("wave_hello_intro");
    expect(clips[1].actionId).toBe(pack.defaults.speaking);
    expect(adjustments.some((a) => a.includes("opening greeting"))).toBe(true);
  });

  it("refuses a sign-off wave while the narration is still running", () => {
    // This show narrates to the last frame, so there is no silent tail for
    // a goodbye to live in — mid-video it reads as the video ending.
    const { clips, adjustments } = buildCharacterTimeline({
      pack,
      scenes: [scene(0, "talk_neutral_loop"), scene(1, "wave_goodbye_outro")],
      allowOutro: false,
    });
    expect(clips[1].actionId).toBe(pack.defaults.speaking);
    expect(adjustments.some((a) => a.includes("still running"))).toBe(true);
  });

  it("allows the sign-off on the closing shot when the video ends there", () => {
    const { clips } = buildCharacterTimeline({
      pack,
      scenes: [scene(0, "talk_neutral_loop"), scene(1, "wave_goodbye_outro")],
      allowOutro: true,
    });
    expect(clips[1].actionId).toBe("wave_goodbye_outro");
  });

  it("makes no adjustments to a plan that already obeys the pack", () => {
    const { adjustments } = buildCharacterTimeline({
      pack,
      scenes: [scene(0, "wave_hello_intro"), scene(1, "talk_both_hands_explain_loop"), scene(2, "surprised_reaction"), scene(3, "talk_emphatic_loop")],
    });
    expect(adjustments).toEqual([]);
  });

  it("returns an empty track for no scenes, rather than inventing one", () => {
    expect(buildCharacterTimeline({ pack, scenes: [] }).clips).toEqual([]);
  });

  it("falls back to an all-default track when PLAN produced nothing", () => {
    const { clips } = defaultTrack(pack, [scene(0, null), scene(1, null)]);
    expect(clips.every((c) => c.actionId === pack.defaults.speaking)).toBe(true);
  });
});
