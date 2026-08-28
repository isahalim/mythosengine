// Client-side mirror of CONSOLE_SPEC.md §3's DirectiveSchema. Used only for
// pre-submit validation UX (instant feedback in the settings composer) —
// the Worker re-validates with its own server-side Zod schema (Phase 8);
// this copy is never the actual security boundary.
import { z } from "zod";

export const DirectiveSchema = z
  .object({
    focusGames: z.array(z.string().max(40)).max(10),
    excludeTopics: z.array(z.string().max(40)).max(25),
    minOriginalityScore: z.number().min(0).max(1),
    maxUploadsPerDay: z.number().int().min(1).max(6),
    tone: z.enum(["neutral", "provocative", "analytical"]).nullable(),
    // The only free text that reaches a prompt (CONSOLE_SPEC.md §3) — wrapped
    // in <operator_note> server-side, never concatenated unfiltered.
    editorialNote: z.string().max(280).nullable(),
    voicePool: z.array(z.string().max(60)).max(12).nullable(),
    ttsRateRange: z.tuple([z.string(), z.string()]).nullable(),
    preferredSourceIds: z.array(z.string()).max(10),
    diversityMode: z.boolean(),
  })
  .strict();

export type DirectiveFormValues = z.infer<typeof DirectiveSchema>;

export const DEFAULT_DIRECTIVE: DirectiveFormValues = {
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
