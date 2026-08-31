import { z } from "zod";

/**
 * SCRIPT stage response shape (ARCHITECTURE.md §5.3, AGENT_PLAYBOOK.md
 * Phase 4's `prompts/script.v1.md`). Zod-first, matching this codebase's
 * established convention (`src/server/console/directive-schema.ts`) rather
 * than a hand-written JSON Schema file — `schemas/script.schema.json` (the
 * literal file the prompt references) is generated from this one source of
 * truth via `z.toJSONSchema()`, not maintained separately.
 */
export const ScriptResponseSchema = z
  .object({
    hook: z.string().min(1),
    body: z.string().min(1),
    debate_question: z.string().min(1),
  })
  .strict();

/** CRITIC stage response shape (ARCHITECTURE.md §5.4, `prompts/critic.v1.md`). Advisory only — never blocks progression. */
export const CriticResponseSchema = z
  .object({
    originality_score: z.number().min(0).max(1),
    policy_flags: z.array(z.string()),
    verdict: z.enum(["approved", "rejected"]),
    reason: z.string().min(1),
  })
  .strict();

/**
 * The `move` a beat performs — plan v2 §4, and the single most load-bearing
 * field in the discourse format. With two hosts the dynamic came free from
 * alternating voices; with one host it has to be made explicit, or the
 * script degrades into the flat narration this format exists to escape.
 *
 * Order here is the canonical order of the argument — `question` ->
 * `attempt` -> `pushback` -> `reframe` -> `land` -> `open` — and it is
 * documentation, not a constraint: a script may skip moves and may repeat
 * them. What it may not do is reach a `land` without ever having been wrong.
 * That rule is structural and lives in `validateBeatStructure`
 * (discourse.ts), because a shape cannot express it.
 */
const DISCOURSE_MOVES = ["question", "attempt", "pushback", "reframe", "land", "open"] as const;

const DiscourseMoveSchema = z.enum(DISCOURSE_MOVES);
export type DiscourseMove = z.infer<typeof DiscourseMoveSchema>;

const DiscourseBeatSchema = z
  .object({
    move: DiscourseMoveSchema,
    text: z.string().min(1),
  })
  .strict();

export type DiscourseBeat = z.infer<typeof DiscourseBeatSchema>;

/**
 * SCRIPT's v3 response (plan v2 §4). `hook` and `open_question` stay
 * top-level rather than being inferred from the first and last beats: they
 * are the two lines the format is most opinionated about — a hook under
 * three seconds, and a closing question that is genuinely unresolved — and
 * asking for them by name is what lets the prompt hold each to its own rule.
 *
 * The beat list carries the argument itself. Two beats is the floor the
 * schema can enforce; the real floor is structural and lives in
 * discourse.ts, because "has at least one pushback between an attempt and a
 * land" is not something a shape can express.
 */
export const DiscourseScriptResponseSchema = z
  .object({
    hook: z.string().min(1),
    beats: z.array(DiscourseBeatSchema).min(2),
    open_question: z.string().min(1),
  })
  .strict();

export type DiscourseScriptResponse = z.infer<typeof DiscourseScriptResponseSchema>;
