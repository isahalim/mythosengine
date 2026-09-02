import { access } from "node:fs/promises";
import { join } from "node:path";
import { CHARACTER_PACK_DIR, loadCharacterPack, type CharacterPack } from "./character-pack.ts";

/**
 * The host — who she is, where she lives, and how she gets on screen.
 *
 * Committed to the repository rather than fetched or stored in
 * `assets-library`: she is the show's identity and appears in every video
 * (plan v2 §2), which makes her source code, not content. The footage
 * branch exists because clips rotate weekly and would bloat history; a
 * character pack that changes only when the show's identity changes has
 * the opposite profile.
 *
 * **What changed on 2026-09-01 (operator direction).** She was one 800x600
 * GIF on a flat red field, composited with `colorkey` and stretched across
 * a two-minute narration by three hand-counted frame holds. All three of
 * those facts are now gone:
 *
 * 1. **No frame holds.** They existed because a single 5.6-second loop
 *    played twenty times reads as fidgeting, and they were pinned to frame
 *    numbers counted off that one asset — replacing the asset meant
 *    recounting them by hand. The pack has 19 real actions and PLAN cuts
 *    between them, which fills the same time with the pack's own material.
 * 2. **No chroma key.** The old asset's background was `#e5505c` and her
 *    face was `#e48080` — the same red channel — which left a tolerance
 *    window where 0.14 began eating her face and 0.20 destroyed it. The
 *    pack's MOVs carry a real 8-bit alpha channel, so there is nothing to
 *    key and no window to get wrong.
 * 3. **No single asset.** `resolveCharacterPack` resolves a *pack*; the
 *    ordered track of actions is built per render by
 *    src/lib/pipeline/character-timeline.ts from PLAN's choices.
 */

/**
 * A third of the frame height. The captions sit at 8% from the bottom and
 * the host is anchored above them, so this is the largest she can be while
 * the caption band still reads against footage rather than against her.
 *
 * Unchanged from the previous host on purpose: her size on screen is a
 * composition decision about this show's frame, not a property of which
 * character pack is loaded.
 */
export const CHARACTER_HEIGHT_RATIO = 0.34;

/**
 * How far above the bottom edge the host floats, as a fraction of frame
 * height.
 *
 * The previous host sat flush on the bottom edge because her torso was
 * deliberately cropped by it — she was drawn to be anchored there. The
 * robot is not: its README is explicit that it "floats clear of all four
 * edges, so the full body is visible", and bottom-flush would plant a
 * floating robot on the floor and clip nothing, which looks like a mistake
 * rather than a choice. This lifts it just clear of the caption band.
 */
export const CHARACTER_BOTTOM_MARGIN_RATIO = 0.1;

export type CharacterResolution =
  | { present: true; pack: CharacterPack }
  | { present: false; reason: string };

/**
 * Resolves the character pack, or explains its absence.
 *
 * A missing pack degrades the video rather than failing the render: the
 * result is v1's look — footage plus captions, no host — which is a
 * complete, publishable Short. Failing instead would throw away a script, a
 * research brief and sourced footage over a directory that is not part of
 * the pipeline's correctness, only its identity.
 *
 * But it is never silent. The reason is returned, logged by the caller, and
 * written into the audit package, because "why is she not in this one" is
 * exactly the question a reviewer will have and exactly the thing they
 * cannot determine from the video itself.
 */
export async function resolveCharacterPack(repoDir: string, packDir: string = CHARACTER_PACK_DIR): Promise<CharacterResolution> {
  const manifestPath = join(repoDir, packDir, "manifest.json");
  try {
    await access(manifestPath);
  } catch {
    return {
      present: false,
      reason: `character pack not found at ${packDir}/manifest.json — rendered without the host (footage and captions only). Restore the pack to that path to bring her back.`,
    };
  }
  try {
    return { present: true, pack: loadCharacterPack(repoDir, packDir) };
  } catch (cause) {
    // A malformed manifest is a broken checkout, but it still must not cost
    // the run its video — same trade as a missing pack, and the reason says
    // which of the two it was.
    return {
      present: false,
      reason: `character pack at ${packDir} could not be read (${cause instanceof Error ? cause.message : String(cause)}) — rendered without the host.`,
    };
  }
}

/**
 * Her voice on the Gemini path — one prebuilt voice, fixed.
 *
 * She is the show's identity and appears in every video (plan v2 §2), so
 * this is not something to rotate. Note the asymmetry that leaves: the Edge
 * fallback still draws from the directive's `voicePool`, which was written
 * for v1's anonymous narrator. A fallback video therefore has her face and a
 * different voice — worth settling when the console grows a host-voice
 * setting, and flagged in the audit package meanwhile by `narration.voice`
 * recording what actually spoke.
 */
export const HOST_GEMINI_VOICE = "Kore";
