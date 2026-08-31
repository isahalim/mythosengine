import { access } from "node:fs/promises";
import { join } from "node:path";
import type { CharacterOverlay } from "../drivers/types.ts";

/**
 * Where the host's loop lives in a checkout.
 *
 * Committed to the repository rather than fetched or stored in
 * `assets-library`: she is the show's identity and is byte-identical in
 * every video (plan v2 §2), which makes her source code, not content. The
 * footage branch exists because clips rotate weekly and would bloat history;
 * one 800×600 loop that never changes has the opposite profile.
 */
export const CHARACTER_ASSET_PATH = join("assets", "character", "right_person.gif");

/**
 * The measured key, not a guessed one (plan v2 §2, verified 2026-08-31 by
 * compositing over a contrast colour and sampling pixels).
 *
 * The asset's background is a perfectly flat `#e5505c` at every corner; her
 * face is `#e48080` — the *same red channel*, 48 and 36 apart in green and
 * blue. That narrow margin is the whole problem, and it is why the tolerance
 * is a ceiling rather than a starting point: **0.14 begins eating her face
 * and 0.20 destroys it.** Raising this number to remove a stray fringe will
 * take her cheeks with it.
 *
 * `blend: 0` keeps the edge hard. A soft blend on a key this tight bleeds
 * the background colour into her outline instead of feathering it.
 */
export const CHARACTER_OVERLAY: CharacterOverlay = {
  filePath: CHARACTER_ASSET_PATH,
  keyColor: "0xe5505c",
  similarity: 0.1,
  blend: 0.0,
  /**
   * A third of the frame height. The captions sit at 8% from the bottom and
   * she is anchored to the bottom edge behind them, so this is the largest
   * she can be while the caption band still reads against her rather than
   * against her face.
   */
  heightRatio: 0.34,
};

export type CharacterResolution =
  | { present: true; overlay: CharacterOverlay }
  | { present: false; reason: string };

/**
 * Resolves the character asset, or explains its absence.
 *
 * A missing asset degrades the video rather than failing the render: the
 * result is v1's look — footage plus captions, no host — which is a
 * complete, publishable Short. Failing instead would throw away a script, a
 * research brief and a claimed footage segment over a file that is not part
 * of the pipeline's correctness, only its identity.
 *
 * But it is never silent. The reason is returned, logged by the caller, and
 * written into the audit package, because "why is she not in this one" is
 * exactly the question a reviewer will have and exactly the thing they
 * cannot determine from the video itself.
 */
export async function resolveCharacterOverlay(repoDir: string, overlay: CharacterOverlay = CHARACTER_OVERLAY): Promise<CharacterResolution> {
  const absolutePath = join(repoDir, overlay.filePath);
  try {
    await access(absolutePath);
  } catch {
    return {
      present: false,
      reason: `character asset not found at ${overlay.filePath} — rendered without the host (footage and captions only). Commit the 800x600 loop to that path to restore her.`,
    };
  }
  return { present: true, overlay: { ...overlay, filePath: absolutePath } };
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
