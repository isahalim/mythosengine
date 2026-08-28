import { z } from "zod";

// CONSOLE_SPEC.md §3, verbatim. `.strict()` so an operator note (or a
// chat-agent tool call) can't smuggle an extra field past validation.
export const DirectiveSchema = z
  .object({
    focusGames: z.array(z.string().max(40)).max(10),
    excludeTopics: z.array(z.string().max(40)).max(25),
    minOriginalityScore: z.number().min(0).max(1),
    maxUploadsPerDay: z.number().int().min(1).max(6),
    tone: z.enum(["neutral", "provocative", "analytical"]).nullable(),
    editorialNote: z.string().max(280).nullable(),
    voicePool: z.array(z.string().max(60)).max(12).nullable(),
    ttsRateRange: z.tuple([z.string(), z.string()]).nullable(),
    preferredSourceIds: z.array(z.string()).max(10),
    diversityMode: z.boolean(),
  })
  .strict();

export type Directive = z.infer<typeof DirectiveSchema>;

/** CONSOLE_SPEC.md §3: "diverse games, diverse topics, diverse voices" with zero configuration. */
export const DEFAULT_DIRECTIVE: Directive = {
  focusGames: [],
  excludeTopics: [],
  minOriginalityScore: 0.5,
  maxUploadsPerDay: 3,
  tone: null,
  editorialNote: null,
  voicePool: null,
  ttsRateRange: null,
  preferredSourceIds: [],
  diversityMode: true,
};
