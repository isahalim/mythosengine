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
 * a machine-readable index of its 19 actions with `use_when`, `category`,
 * `mouth_moving`, `gesture` and `duration_ms` on each, plus an
 * `agent_selection_rules` array, so PLAN can be handed the vocabulary at
 * run time and this module can check the answer against it.
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
  /** The manifest's own fallbacks: what to play when no rule applies. */
  defaults: { speaking: string; silent: string };
  /** The manifest's selection rules, passed verbatim into the PLAN prompt so the model is briefed by the pack rather than by us. */
  agentSelectionRules: string[];
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
    agentSelectionRules: parsed.agent_selection_rules,
  };
}

/** Absolute path to one action's alpha MOV. The MOV, never the GIF: GIF alpha is 1-bit, so its edges harden into a jagged outline over busy footage (the pack's README says so, and it is right). */
export function clipPath(pack: CharacterPack, actionId: string): string {
  const clip = pack.byId.get(actionId);
  if (clip === undefined) throw new Error(`character pack ${pack.pack} has no action "${actionId}"`);
  return join(pack.dir, clip.files.mov_alpha);
}

/**
 * The action ids, as the PLAN prompt lists them for the model.
 *
 * Rendered from the manifest rather than pasted into the prompt file, so a
 * pack that gains or loses an action cannot leave the prompt advertising
 * something that no longer exists — the failure mode where the model keeps
 * confidently naming a clip nobody can play.
 */
export function describeActionsForPrompt(pack: CharacterPack): string {
  return pack.clips
    .map((clip) => `  ${clip.id} (${clip.category}, ${clip.mouth_moving ? "speaking" : "silent"}) — ${clip.use_when}`)
    .join("\n");
}

/**
 * Whether an action id exists in this pack. The deterministic check behind
 * PLAN: a model that invents `talk_shrug_loop` gets its shot defaulted
 * rather than a render that dies looking for a file.
 */
export function isKnownAction(pack: CharacterPack, actionId: string): boolean {
  return pack.byId.has(actionId);
}

/** True for the two transition actions the manifest restricts to the ends of a video. */
export function isTransition(pack: CharacterPack, actionId: string): boolean {
  return pack.byId.get(actionId)?.category === "transition";
}

export function isReaction(pack: CharacterPack, actionId: string): boolean {
  return pack.byId.get(actionId)?.category === "reaction";
}

/** The manifest's own intro/outro ids, found by category so renaming them in the pack does not strand this code. */
export function transitionIds(pack: CharacterPack): { intro: string | null; outro: string | null } {
  const transitions = pack.clips.filter((clip) => clip.category === "transition");
  return {
    intro: transitions.find((clip) => /hello|intro/i.test(clip.id))?.id ?? null,
    outro: transitions.find((clip) => /goodbye|outro/i.test(clip.id))?.id ?? null,
  };
}
