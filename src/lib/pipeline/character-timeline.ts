import type { CharacterClip } from "../drivers/types.ts";
import { clipPath, isKnownAction, isReaction, isTransition, transitionIds, type CharacterPack } from "./character-pack.ts";

/**
 * The host's action track for one render: which of the pack's 19 actions is
 * on screen, and for how long.
 *
 * **The cuts are the footage's cuts.** One action per composited shot,
 * sharing that shot's exact span — so when the picture turns because the
 * argument turned (src/lib/pipeline/montage-timeline.ts), the host turns
 * with it. Giving the host its own independent cutting rhythm was the
 * obvious alternative and is worse: two unrelated cadences cutting past
 * each other reads as a sync fault, and there is no third thing on screen
 * to motivate a host cut that the footage does not.
 *
 * **Why the rules are enforced here rather than trusted to PLAN.** The
 * pack's `agent_selection_rules` are handed to the model in the prompt, and
 * a model mostly follows them. Mostly is not good enough for the ones whose
 * violation is *visible*: two reactions back to back reads as a twitch, a
 * goodbye wave in the middle of an argument reads as the video ending, and
 * an action id that does not exist is a missing file at encode time. Those
 * three are checked deterministically, after the model, the same way
 * `validateShots` checks the queries PLAN emits. Every correction is
 * recorded and reaches the audit package — a silent fix would leave a
 * reviewer unable to tell what PLAN actually chose.
 *
 * Pure, and separated from both the pack loader and the encoder for that
 * reason: which action plays when is the part of this feature that can be
 * wrong in a way you only notice in the finished video, so it is the part
 * that gets tested without a file system or an encoder anywhere near it.
 */

export interface CharacterScene {
  /** The composited footage shot this action covers. */
  position: number;
  /** What PLAN chose, or null if it chose nothing for this shot. */
  actionId: string | null;
  /** Seconds this shot is on screen — the span the action must fill. */
  durationS: number;
}

export interface CharacterTimelineInput {
  pack: CharacterPack;
  scenes: CharacterScene[];
  /**
   * Whether the narration is still running under the last scene. The outro
   * wave is a sign-off, so it belongs only where the video actually ends.
   */
  allowOutro?: boolean;
}

export interface CharacterTimelineResult {
  clips: CharacterClip[];
  /** Every correction made to PLAN's choices, in order, for the audit package. Empty when the model's plan was used as given. */
  adjustments: string[];
}

/**
 * Lays the host's actions across the narration.
 *
 * Returns an empty track only for an empty input — a render with no
 * composited shots has no host, which the caller treats as "no overlay"
 * rather than as an error.
 */
export function buildCharacterTimeline(input: CharacterTimelineInput): CharacterTimelineResult {
  const { pack, scenes } = input;
  const adjustments: string[] = [];
  if (scenes.length === 0) return { clips: [], adjustments };

  const { intro, outro } = transitionIds(pack);
  const allowOutro = input.allowOutro ?? true;

  const chosen: string[] = [];

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const isFirst = i === 0;
    const isLast = i === scenes.length - 1;
    let action = scene.actionId;

    // 1. Nothing chosen, or an action this pack does not have. A model that
    //    invents an id must not become a missing file at encode time.
    if (action === null) {
      action = pack.defaults.speaking;
      adjustments.push(`shot ${scene.position}: PLAN chose no action — defaulted to ${action}.`);
    } else if (!isKnownAction(pack, action)) {
      const invented = action;
      action = pack.defaults.speaking;
      adjustments.push(`shot ${scene.position}: "${invented}" is not an action in pack ${pack.pack} — defaulted to ${action}.`);
    }

    // 2. Transitions belong at the ends and nowhere else. A goodbye wave
    //    mid-argument reads as the video ending; a hello wave in the middle
    //    reads as a second video starting.
    if (isTransition(pack, action)) {
      if (action === intro && !isFirst) {
        adjustments.push(`shot ${scene.position}: ${action} is the opening greeting and this is not the opening shot — replaced with ${pack.defaults.speaking}.`);
        action = pack.defaults.speaking;
      } else if (action === outro && !(isLast && allowOutro)) {
        const why = isLast ? "the narration is still running here" : "this is not the closing shot";
        adjustments.push(`shot ${scene.position}: ${action} is the sign-off and ${why} — replaced with ${pack.defaults.speaking}.`);
        action = pack.defaults.speaking;
      }
    }

    // 3. Never two reactions in a row. The pack's own rule, and the one
    //    whose violation is most obviously wrong on screen: reactions are
    //    single beats of emphasis, and chaining them reads as a twitch
    //    rather than as a response to anything.
    const previous = chosen[chosen.length - 1];
    if (previous !== undefined && isReaction(pack, action) && isReaction(pack, previous)) {
      adjustments.push(`shot ${scene.position}: ${action} follows the reaction ${previous} — replaced with ${pack.defaults.speaking}, because reactions are one beat and do not chain.`);
      action = pack.defaults.speaking;
    }

    chosen.push(action);
  }

  const clips: CharacterClip[] = scenes.map((scene, i) => ({
    filePath: clipPath(pack, chosen[i]),
    actionId: chosen[i],
    durationS: scene.durationS,
  }));

  return { clips, adjustments };
}

/**
 * The default action for a shot with no plan at all — the whole-track
 * fallback used when PLAN was degraded and chose nothing for anything.
 *
 * Speaking rather than idle, because this show is continuous voiceover:
 * the host is talking under every shot unless a reaction beat says
 * otherwise, and a silent idle loop under narration reads as a dropped
 * lip-sync rather than as a stylistic choice.
 */
export function defaultTrack(pack: CharacterPack, scenes: CharacterScene[]): CharacterTimelineResult {
  return buildCharacterTimeline({
    pack,
    scenes: scenes.map((scene) => ({ ...scene, actionId: pack.defaults.speaking })),
  });
}
