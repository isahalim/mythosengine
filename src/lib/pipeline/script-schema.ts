import { z } from "zod";

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
 * The `move` a beat performs — the single most load-bearing field in the
 * script format. With two hosts the dynamic came free from alternating
 * voices; with one host it has to be made explicit, or the script degrades
 * into the flat narration this format exists to escape.
 *
 * The first six are the discourse arc — `question` -> `attempt` ->
 * `pushback` -> `reframe` -> `land` -> `open` — which was the *only* shape a
 * script could take until 2026-09-03. It is now one format among several
 * (see `SCRIPT_FORMATS` in performance.ts), so the vocabulary widened to
 * cover what the others actually do: a story has a `setup` and a `turn`, a
 * hot take has `evidence` and a `verdict`, and every format wants an `aside`
 * and a `punchline` available for the joke the writer is asked to land.
 *
 * Nothing here is enforced as an ordering any more. The lecture gate that
 * required a `pushback` between an `attempt` and a `land` was removed by
 * operator direction on 2026-09-03: it could only ever describe one of these
 * formats, and it failed whole renders for scripts that were merely a
 * different shape. `move` now feeds delivery direction (tts-direction.ts),
 * PLAN's shot hints, and beat boundaries for the footage cuts — all of which
 * degrade gracefully on a move they did not expect, which the gate did not.
 */
const BEAT_MOVES = [
  // The discourse arc.
  "question",
  "attempt",
  "pushback",
  "reframe",
  "land",
  "open",
  // Narrative and argumentative shapes.
  "setup",
  "turn",
  "escalation",
  "evidence",
  "verdict",
  "confession",
  // Available to every format.
  "aside",
  "punchline",
] as const;

const BeatMoveSchema = z.enum(BEAT_MOVES);
export type BeatMove = z.infer<typeof BeatMoveSchema>;

const DiscourseBeatSchema = z
  .object({
    move: BeatMoveSchema,
    text: z.string().min(1),
  })
  .strict();

export type DiscourseBeat = z.infer<typeof DiscourseBeatSchema>;

/**
 * SCRIPT's response. `hook` and `open_question` stay top-level rather than
 * being inferred from the first and last beats: they are the two lines every
 * format is most opinionated about — a hook under three seconds, and a
 * closing line that leaves something genuinely open — and asking for them by
 * name is what lets the prompt hold each to its own rule.
 *
 * Beat `text` may carry inline delivery tags (`[giggles]`, `[excitedly]`).
 * They are stripped on every path but the Gemini TTS one — see
 * delivery-tags.ts, which is where that guarantee actually lives.
 *
 * Two beats is the floor, and it is the only structural rule left. The
 * ordering gate that once sat behind this schema was removed by operator
 * direction on 2026-09-03.
 */
export const DiscourseScriptResponseSchema = z
  .object({
    hook: z.string().min(1),
    beats: z.array(DiscourseBeatSchema).min(2),
    open_question: z.string().min(1),
  })
  .strict();

export type DiscourseScriptResponse = z.infer<typeof DiscourseScriptResponseSchema>;
