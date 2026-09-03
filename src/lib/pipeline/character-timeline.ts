import { actionSequence, type PackAction, type CharacterPack } from "./character-pack.ts";
import type { CharacterClip } from "../drivers/types.ts";

/**
 * The host's action track for one render: which of the pack's actions is on
 * screen, and for how long.
 *
 * **Deterministic, start to finish** (operator direction, 2026-09-03). The
 * host waves hello, runs every other action in the pack once through in
 * manifest order, loops that cycle for as long as the video lasts, and waves
 * goodbye at the end. That is the entire rule. Nothing chooses; there is no
 * input here but the pack and a duration.
 *
 * **What this replaced, and why it is not a downgrade.** From 2026-09-01 PLAN
 * picked one action per shot from the manifest's `use_when` descriptions, and
 * this module then re-checked those picks against the pack's
 * `agent_selection_rules` and corrected the ones whose violation was visible
 * — a mid-video sign-off, two chained reactions, an invented id. Both halves
 * are gone. What that arrangement bought was a host whose gestures tracked
 * the argument; what it cost was a model call whose output had to be
 * validated, a per-shot correction log in every audit package, and a class of
 * failure a reviewer could only find by watching. A fixed cycle cannot be
 * wrong, cannot be corrected, costs nothing and is identical in every video.
 *
 * Two consequences worth knowing rather than discovering. The host now cuts
 * on its own cadence instead of on the footage's, so its cuts and the
 * montage's drift past each other. And the cycle includes the pack's silent
 * actions (idle, nod, shrug, thinking), which play under continuous
 * narration. Both follow directly from "every animation in sequence" and both
 * were accepted when this was specified.
 *
 * Pure, and separated from both the pack loader and the encoder for that
 * reason: which action plays when is the part of this feature that can be
 * wrong in a way you only notice in the finished video, so it is the part
 * that gets tested without a file system or an encoder anywhere near it.
 */

/**
 * The shortest an action may be on screen.
 *
 * The pack runs at 12fps, so this is ten frames. Below about that, a hard cut
 * in and a hard cut out of a different action reads as a dropped frame rather
 * than as a gesture — and the only clip that is ever trimmed is the one that
 * lands the goodbye wave on the end of the video, which would otherwise be
 * whatever remainder the arithmetic happened to leave.
 */
const MIN_ACTION_S = 0.8;

export interface CharacterTimelineInput {
  pack: CharacterPack;
  /** Seconds of finished video the host has to cover, from the first frame to the last. */
  videoDurationS: number;
}

export interface CharacterTimelineResult {
  clips: CharacterClip[];
  /** Total length of the track. Never less than `videoDurationS` — see `buildCharacterTimeline`. */
  trackDurationS: number;
}

/**
 * Lays the host's actions across the whole video.
 *
 * **The track is always at least as long as the video, never shorter**, and
 * that asymmetry is deliberate. The encoder cuts the composite at the
 * video's own duration, so an overshoot costs the goodbye wave up to
 * `MIN_ACTION_S` of its tail — a 3.0s wave playing 2.2s, which still reads
 * as a wave. An undershoot would cost the last fraction of a second its host
 * entirely, and a presenter blinking out just before the end is the kind of
 * defect that looks like a crash. Given the choice, overshoot.
 *
 * Returns an empty track only for a video with no duration, which the caller
 * treats as "no overlay" rather than as an error.
 */
export function buildCharacterTimeline(input: CharacterTimelineInput): CharacterTimelineResult {
  const { videoDurationS } = input;
  if (!Number.isFinite(videoDurationS) || videoDurationS <= 0) return { clips: [], trackDurationS: 0 };

  const { intro, middle, outro } = actionSequence(input.pack);
  const clips: CharacterClip[] = [];
  const play = (action: PackAction, durationS: number): void => {
    clips.push({ filePath: action.filePath, actionId: action.id, durationS, naturalDurationS: action.durationS });
  };

  // The greeting, whole. A video too short to hold it is cut by the encoder
  // rather than trimmed here: a wave that gets cut off is a wave, and a
  // 2-second video has no room for a running order anyway.
  if (intro !== null) play(intro, intro.durationS);
  let elapsed = intro === null ? 0 : intro.durationS;

  // Time the sign-off needs at the end. Reserved before the cycle runs, so
  // the last thing the viewer sees is the whole goodbye and not whatever the
  // cycle happened to be in the middle of.
  const outroS = outro?.durationS ?? 0;

  if (middle.length > 0) {
    // Whole actions, in the pack's order, cycling for as long as one more
    // whole action still leaves room for the sign-off.
    let i = 0;
    while (elapsed + middle[i % middle.length].durationS + outroS <= videoDurationS) {
      const action = middle[i % middle.length];
      play(action, action.durationS);
      elapsed += action.durationS;
      i++;
    }

    // One partial action closes the gap between the last whole one and the
    // sign-off. `Math.max` is what makes the track overshoot rather than
    // flicker: a 0.2s remainder is played as 0.8s and the encoder takes the
    // difference off the end of the wave.
    const gap = videoDurationS - elapsed - outroS;
    if (gap > 0) {
      const action = middle[i % middle.length];
      const durationS = Math.min(Math.max(gap, MIN_ACTION_S), action.durationS);
      play(action, durationS);
      elapsed += durationS;
    }
  }

  if (outro !== null) {
    play(outro, outro.durationS);
    elapsed += outro.durationS;
  }

  return { clips, trackDurationS: elapsed };
}
