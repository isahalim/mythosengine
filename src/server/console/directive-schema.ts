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
    /**
     * Seconds of narration each video is written for (plan v2 §1: the
     * discourse format's 60-180s range, replacing v1's fixed ~47s).
     *
     * SCRIPT writes to this and its structural gate checks against it, so it
     * is the one number that decides how long a video is. Nullable so a
     * directive saved before the format changed still validates; a null
     * reads as `DEFAULT_TARGET_DURATION_S`.
     */
    targetDurationS: z.number().int().min(60).max(180).nullable(),
    /**
     * Whether each beat's `move` is carried into the TTS call as inline
     * delivery direction, or one flat style covers the script.
     *
     * Off by default, and deliberately so: whether inline direction actually
     * shifts delivery mid-utterance is **unmeasured** (plan v2 §9), and a
     * default that depends on an untested provider behaviour would make
     * every video an experiment. Turn it on to run the experiment.
     */
    perBeatDelivery: z.boolean(),
  })
  .strict();

/** Mid-range of the format's 60-180s window — long enough for the argument to build, short enough not to bet the video on the untested ceiling. */
export const DEFAULT_TARGET_DURATION_S = 90;

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
  targetDurationS: DEFAULT_TARGET_DURATION_S,
  perBeatDelivery: false,
};
