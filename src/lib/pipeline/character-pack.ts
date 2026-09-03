import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * The host's action pack, read from the pack's own manifest.
 *
 * **Why the manifest is the source of truth and this file hard-codes almost
 * nothing.** The previous host was one GIF plus three frame numbers counted
 * by hand off that exact asset (`{atFrame: 3}`, `{atFrame: 12}`,
 * `{atFrame: 28}`), which meant swapping the character meant recounting
 * them — the asset and the code were welded together. The robot pack ships
 * a machine-readable index of its 19 actions with `category` and
 * `duration_ms` on each, and that index is the whole of what decides what
 * plays when.
 *
 * **No model reads any of this** (operator direction, 2026-09-03). PLAN used
 * to be handed the action vocabulary and the pack's `agent_selection_rules`
 * and asked to choose one action per shot; `character-timeline.ts` then
 * corrected its choices against those same rules. Both halves are gone. The
 * host now runs the pack's own clips in manifest order, on a loop, with the
 * waves at the ends — which is deterministic, free, and identical in every
 * video, so a reviewer never has to ask why the host did what it did.
 * `use_when`, `mouth_moving`, `gesture` and `agent_selection_rules` were
 * written for a model to read and no longer have a reader; they stay in the
 * manifest because it is the pack's file, not ours.
 *
 * The pack's README states that its 19 action ids are shared with the human
 * host pack deliberately, so the two are drop-in interchangeable. Pointing
 * `CHARACTER_PACK_DIR` at a different folder is therefore the whole of
 * "change the presenter" — no code here knows it is a robot.
 */

/** Where the pack lives in a checkout. Committed, like the host it replaced: she is the show's identity, not content. */
export const CHARACTER_PACK_DIR = join("assets", "character", "robot_character_pack");

const ClipSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    category: z.enum(["talking", "idle", "reaction", "transition"]),
    use_when: z.string().min(1),
    mouth_moving: z.boolean(),
    gesture: z.string(),
    duration_ms: z.number().positive(),
    files: z.object({ gif: z.string().min(1), mov_alpha: z.string().min(1) }),
  })
  .loose();

const ManifestSchema = z
  .object({
    pack: z.string().min(1),
    version: z.string().min(1),
    defaults: z.object({ speaking: z.string().min(1), silent: z.string().min(1) }),
    agent_selection_rules: z.array(z.string().min(1)).min(1),
    clips: z.array(ClipSchema).min(1),
  })
  .loose();

type CharacterClipSpec = z.infer<typeof ClipSchema>;

export interface CharacterPack {
  /** Absolute path to the pack directory. */
  dir: string;
  pack: string;
  version: string;
  clips: CharacterClipSpec[];
  byId: Map<string, CharacterClipSpec>;
  /** The manifest's own fallbacks. Only `speaking` is read now — it is what a pack with no transition clips opens and closes on. */
  defaults: { speaking: string; silent: string };
}

/**
 * Reads and validates the pack.
 *
 * Throws rather than returning a `Result`, and deliberately: this is a
 * committed asset read at startup, so a malformed manifest is a broken
 * checkout, not a runtime condition to degrade around. The absence of the
 * whole pack IS a runtime condition, and `resolveCharacterPack`
 * (character.ts) handles that one by rendering without a host.
 */
export function loadCharacterPack(repoDir: string, packDir: string = CHARACTER_PACK_DIR): CharacterPack {
  const dir = join(repoDir, packDir);
  const parsed = ManifestSchema.parse(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")));

  const byId = new Map(parsed.clips.map((clip) => [clip.id, clip]));
  for (const id of [parsed.defaults.speaking, parsed.defaults.silent]) {
    if (!byId.has(id)) throw new Error(`character pack ${parsed.pack} names a default action "${id}" that is not among its own clips`);
  }

  return {
    dir,
    pack: parsed.pack,
    version: parsed.version,
    clips: parsed.clips,
    byId,
    defaults: parsed.defaults,
  };
}

/** Absolute path to one action's alpha MOV. The MOV, never the GIF: GIF alpha is 1-bit, so its edges harden into a jagged outline over busy footage (the pack's README says so, and it is right). */
export function clipPath(pack: CharacterPack, actionId: string): string {
  const clip = pack.byId.get(actionId);
  if (clip === undefined) throw new Error(`character pack ${pack.pack} has no action "${actionId}"`);
  return join(pack.dir, clip.files.mov_alpha);
}

/** One action, as the timeline needs it: where the file is and how long it runs. */
export interface PackAction {
  id: string;
  filePath: string;
  /** The clip's own length in seconds, from the manifest. This is how long it plays; nothing stretches it. */
  durationS: number;
}

/**
 * The pack, laid out as the fixed running order the host performs.
 *
 * `intro` and `outro` are the waves, and `middle` is everything else in the
 * manifest's own order. That order is not incidental — the pack lists its
 * talking clips first and its reactions after, so cycling it reads as a
 * presenter working through a point and then reacting, rather than as a
 * shuffle. Keeping the manifest's order also means re-ordering the
 * performance is editing the pack's JSON, with no code involved.
 *
 * The waves are found by `category === "transition"` and then by id, the
 * same way the deleted `transitionIds` did, so renaming them in the pack
 * does not strand this code. A pack with no transitions at all gets nulls
 * and no waves: `buildCharacterTimeline` then runs the middle straight
 * through, which is the right degradation for a pack that never had a
 * greeting to give.
 */
export interface ActionSequence {
  intro: PackAction | null;
  middle: PackAction[];
  outro: PackAction | null;
}

function toAction(pack: CharacterPack, clip: CharacterClipSpec): PackAction {
  return { id: clip.id, filePath: join(pack.dir, clip.files.mov_alpha), durationS: clip.duration_ms / 1000 };
}

export function actionSequence(pack: CharacterPack): ActionSequence {
  const transitions = pack.clips.filter((clip) => clip.category === "transition");
  const intro = transitions.find((clip) => /hello|intro/i.test(clip.id)) ?? null;
  const outro = transitions.find((clip) => /goodbye|outro/i.test(clip.id)) ?? null;
  const ends = new Set([intro?.id, outro?.id]);

  // Every non-wave clip, manifest order. A `transition` that is neither the
  // hello nor the goodbye — this pack's README says its ids are shared with
  // a human host pack, so a third one is possible — stays in the cycle
  // rather than being silently dropped.
  const middle = pack.clips.filter((clip) => !ends.has(clip.id));

  return {
    intro: intro === null ? null : toAction(pack, intro),
    // A pack of nothing but waves has no cycle to run, and a track of one
    // hello and one goodbye would leave the rest of the video hostless.
    // Everything it has, then, waves included — the alternative is a
    // presenter who vanishes two minutes before the end.
    middle: (middle.length > 0 ? middle : pack.clips).map((clip) => toAction(pack, clip)),
    outro: outro === null ? null : toAction(pack, outro),
  };
}
