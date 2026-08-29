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
