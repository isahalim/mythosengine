import { hammingDistance, simhash64 } from "../ingest/simhash.ts";

/**
 * AUDIT SUMMARY (ARCHITECTURE.md §9) — the same checks the old POLICY GATE
 * ran, computed the same deterministic way, but advisory only. Nothing here
 * blocks a render from reaching EXPORT; every result is a flag for the
 * human reviewer, not a rejection. Pure function, no DB/network access, no
 * model call.
 */

/**
 * One clip in the finished video's footage track.
 *
 * `startMs`/`endMs` are positions in the *output*, so a reviewer watching
 * the video can put a shot they are questioning against the row that
 * explains it. The stock fields are null on a gameplay clip, where the
 * channel on the source row is the whole attribution, and set together on a
 * stock one — the Pexels licence is per clip and per photographer, and an
 * export that names neither cannot be licence-checked.
 */
export interface FootagePart {
  position: number;
  segmentId: string;
  startMs: number;
  endMs: number;
  provider: string | null;
  providerClipId: string | null;
  photographer: string | null;
  pageUrl: string | null;
  /** The keyword that retrieved this shot — why it is in this video at all. */
  searchQuery: string | null;
  /** The script beat this shot illustrates; null for the hook's establishing shot or a single looped clip. */
  beatIndex: number | null;
  /**
   * The span of the **source** this clip was cut from, in seconds — where
   * `startMs`/`endMs` above are the span of the *output* it occupies.
   *
   * A reviewer asking "which YouTube videos are in this, and which part of
   * each?" cannot answer it from anything else in the package: `pageUrl`
   * names the video and `startMs` names a moment in the short, and neither
   * one composed with the other gives the minute of the source that was
   * actually used. Null on a record written before this field existed —
   * missing reads as missing, never as "from the beginning".
   */
  sourceStartS: number | null;
  sourceEndS: number | null;
}

export interface FootageProvenance {
  segmentId: string;
  footageSourceId: string;
  sourceVideoId: string;
  clipStartS: number;
  clipEndS: number;
  usedCount: number;
  /**
   * Every clip in the video, in order. Required, not optional: a montage
   * whose parts were merely absent would be indistinguishable from a single
   * looped clip, and CLAUDE.md forbids an export that leaves the reviewer to
   * infer where a frame came from. A gameplay render has exactly one part,
   * and the fields above describe that same clip.
   */
  parts: FootagePart[];
}

/**
 * What RESEARCH (ARCHITECTURE.md §5.2.5) contributed to this render, as the
 * reviewer sees it. `null` means the stage failed or was skipped and the
 * script was written from the signal title alone — a supported, degraded
 * path that must be visible, never inferred from an absent field.
 */
export interface ResearchProvenance {
  model: string;
  summary: string;
  citations: { signalId: string; claim: string; title: string; url: string; sourceKind: string }[];
  toolCallsMade: string[];
}

/**
 * The narration settings **actually used**, which §9 requires the audit
 * package to state.
 *
 * "Actually" is the load-bearing word. The operator's directive names a
 * voice and a rate; what reached the audio may differ, because the Gemini
 * upgrade can be unavailable or can fail mid-render and fall back to Edge.
 * A reviewer listening to a flat read needs to be able to tell "the upgrade
 * was out of budget today" from "the style direction did nothing" — and
 * neither is recoverable from the video itself.
 */
interface NarrationProvenance {
  driver: "edge-tts" | "gemini-tts";
  voice: string;
  rate: string | null;
  /** The inline direction sent, or null on a path that has none. */
  styleDirection: string | null;
  /** Why this is not the driver the operator would otherwise have got. Null when nothing was downgraded. */
  fallbackReason: string | null;
  /**
   * Fraction of the script's words ALIGN matched against the transcript, or
   * null on the Edge path — which needs no alignment because its timings are
   * native and exact.
   */
  alignMatchRatio: number | null;
  /**
   * Where the caption timings came from, which decides how much to trust
   * them:
   *
   * - `native` — Edge TTS's own WordBoundary events. Exact.
   * - `aligned` — ALIGN force-aligned a transcript of the Gemini audio.
   *   Accurate to `alignMatchRatio`.
   * - `estimated` — ALIGN failed and the words were spread evenly across the
   *   narration's measured duration. The video is complete and watchable and
   *   the captions will drift within a sentence.
   *
   * The third state exists because losing a finished video to a failed
   * transcription call is the worse trade (2026-09-01, operator direction) —
   * the same reasoning §5.2.5 already applies to RESEARCH. It is recorded
   * and flagged rather than silently accepted, because a reviewer cannot
   * tell drifting captions from a bad take without being told which one
   * they are watching.
   */
  captionTiming: "native" | "aligned" | "estimated";
}

/**
 * Which of the host's actions played over each shot, and every correction
 * made to PLAN's choices.
 *
 * In the audit package because it is a claim about the finished video that
 * a reviewer cannot check from the video alone: watching it tells you the
 * host shrugged over beat four, but not whether PLAN chose that or whether
 * the timeline substituted it for an invented id or a chained reaction.
 */
interface CharacterProvenance {
  pack: string;
  packVersion: string;
  /** Composited shot position -> the action that actually played. */
  actions: { position: number; actionId: string }[];
  /** Corrections the timeline had to make to PLAN's choices. Empty when the plan was used as given. */
  adjustments: string[];
}

/**
 * What EDIT did to each clip.
 *
 * Kinocut calls its equivalent a "Video Receipt", and the reasoning is the
 * same one this system's audit package is built on: a human reviewing an
 * agent's edit needs to know which operations ran, not just what came out.
 * A clip that was trimmed to a different moment than the one SOURCE chose
 * is a clip whose footage provenance window is no longer the whole story.
 */
interface EditProvenance {
  /** The model that drove the edit, or null when EDIT did not run. */
  model: string | null;
  /** Why EDIT did not run, or null when it did. */
  degradedReason: string | null;
  clips: { position: number; edited: boolean; toolsRun: string[]; skippedReason: string | null }[];
}

/**
 * Which provider and model actually answered a reasoning stage.
 *
 * The audit package's job is to let a reviewer answer "what wrote this?"
 * from the export alone, months later, without knowing which build produced
 * it — and this repo has changed that answer three times in a week.
 *
 * As of 2026-09-02 the answer genuinely varies between exports rather than
 * being the same pair repeated: RESEARCH tries Gemini first and falls back
 * to Groq on any failure (src/lib/rag/research-provider.ts), so two videos
 * rendered an hour apart can have briefs from different providers, built
 * from different amounts of source text. `fallbackReason` is what makes
 * that legible instead of merely visible.
 */
interface StageProvenance {
  stage: string;
  provider: "groq" | "gemini";
  model: string;
  /**
   * Why this stage is not on the provider it would have preferred, or null
   * when nothing was downgraded.
   *
   * Only RESEARCH can be non-null today; every other stage has one provider
   * and no fallback to explain. A reviewer reading "groq" here without a
   * reason would have no way to tell a deliberate configuration from a
   * quota failure.
   */
  fallbackReason: string | null;
}

export interface AuditSummaryInput {
  script: { hook: string; body: string; debateQuestion: string; wordCount: number };
  /**
   * Seconds of narration the script was written for, or null for a v1 prose
   * script. When present, the word-count check derives its bounds from this
   * instead of using v1's fixed 130-170 — a 180-second discourse script is
   * *supposed* to be 500 words, and flagging it against a 47-second video's
   * range would make the flag meaningless.
   */
  targetDurationS: number | null;
  /** How the narration was actually produced. Null only for callers that predate the discourse format. */
  narration: NarrationProvenance | null;
  /** Why the host is not on screen, or null when she is. */
  characterAbsentReason: string | null;
  /** Which actions the host performed, or null when she is not on screen. */
  character: CharacterProvenance | null;
  /** What EDIT did to each clip. Null only for callers that predate the stage. */
  edit: EditProvenance | null;
  /** Which provider and model answered RESEARCH, SCRIPT and PLAN. */
  stages: StageProvenance[];
  originalityScore: number | null;
  minOriginalityScore: number;
  policyFlags: string[];
  footage: FootageProvenance;
  /** The brief the script was written from, or null when RESEARCH failed. */
  research: ResearchProvenance | null;
  voiceUsedToday: boolean;
  /** Bodies of the last up-to-100 scripts, most recent first — for self-repetition detection. */
  recentScriptBodies: readonly string[];
  narrationDurationS: number;
  captionEndMs: number;
  /** How far captions may run past/before the narration before it's flagged. */
  durationToleranceMs: number;
}

export interface AuditResult {
  schemaValid: boolean;
  wordCountInBounds: boolean;
  narration: NarrationProvenance | null;
  /** True when the narration ran on a driver other than the best one available. */
  narrationDowngraded: boolean;
  characterAbsentReason: string | null;
  character: CharacterProvenance | null;
  edit: EditProvenance | null;
  stages: StageProvenance[];
  hasDebateQuestion: boolean;
  originalityScore: number | null;
  clearsOriginalityFloor: boolean;
  policyFlags: string[];
  footage: FootageProvenance;
  footageRecentlyUsed: boolean; // usedCount > 0 before this claim — a rotation-health signal, not a violation
  research: ResearchProvenance | null;
  /** True when the script was written with no retrieved grounding — informational, and the reviewer is told rather than left to notice. */
  ungrounded: boolean;
  voiceUsedToday: boolean;
  scriptSimilarity: { maxSimilarity: number; mostSimilarIndex: number } | null;
  flaggedAsRepeat: boolean;
  durationMatch: { deltaMs: number; withinTolerance: boolean };
  syntheticMediaDisclosureReminder: true;
  /** Human-readable summary of anything that looks risky — surfaced first in the review UI. */
  flags: string[];
}

const SCRIPT_SIMILARITY_FLAG_THRESHOLD = 0.85;
/** v1's fixed range, used only when a script carries no target duration. */
const MIN_WORD_COUNT = 130;
const MAX_WORD_COUNT = 170;
/** Same estimator and tolerance the SCRIPT gate uses (discourse.ts) — one ruler, so the two stages cannot disagree. */
const WORDS_PER_MINUTE = 165;
const DURATION_TOLERANCE = 0.25;

function wordCountBounds(targetDurationS: number | null): { min: number; max: number } {
  if (targetDurationS === null) return { min: MIN_WORD_COUNT, max: MAX_WORD_COUNT };
  const expected = (targetDurationS / 60) * WORDS_PER_MINUTE;
  return { min: Math.round(expected * (1 - DURATION_TOLERANCE)), max: Math.round(expected * (1 + DURATION_TOLERANCE)) };
}

/**
 * `simhash64`/`hammingDistance` (src/lib/ingest/simhash.ts) were built and
 * threshold-calibrated for headline-length WATCH dedup, not 130-170 word
 * script bodies — the fingerprint function itself is generic, but treat
 * this 0.85 similarity threshold as an honest starting point converted
 * from that 64-bit distance scale, not independently validated against
 * real script-length text. Revisit once real script history exists to
 * calibrate against (same "don't fake a validated number" reasoning Phase 1
 * used for the embed/vector driver stubs).
 */
function scriptSimilarity(a: string, b: string): number {
  const distance = hammingDistance(simhash64(a), simhash64(b));
  return 1 - distance / 64;
}

export function computeAuditSummary(input: AuditSummaryInput): AuditResult {
  const flags: string[] = [];

  const bounds = wordCountBounds(input.targetDurationS);
  const wordCountInBounds = input.script.wordCount >= bounds.min && input.script.wordCount <= bounds.max;
  if (!wordCountInBounds) flags.push(`word count ${input.script.wordCount} outside ${bounds.min}-${bounds.max}`);

  // Flagged, not failed: a downgraded voice is a complete video the operator
  // may well publish, but it is not the video they configured, and that
  // difference has to be visible in review rather than only in a log line
  // from a job that has already exited.
  const narrationDowngraded = input.narration?.fallbackReason != null;
  if (input.narration?.fallbackReason) flags.push(`narration on ${input.narration.driver}: ${input.narration.fallbackReason}`);
  if (input.characterAbsentReason) flags.push(`no host on screen: ${input.characterAbsentReason}`);
  if (input.narration?.captionTiming === "estimated") {
    flags.push("caption timings estimated — ALIGN failed, so words are spread evenly across the narration and will drift within a sentence");
  }

  const hasDebateQuestion = input.script.debateQuestion.trim().length > 0;
  if (!hasDebateQuestion) flags.push("no debate question");

  const clearsOriginalityFloor = input.originalityScore !== null && input.originalityScore >= input.minOriginalityScore;
  if (!clearsOriginalityFloor) {
    flags.push(
      input.originalityScore === null
        ? "no originality score"
        : `originality ${input.originalityScore.toFixed(2)} below floor ${input.minOriginalityScore.toFixed(2)}`,
    );
  }

  for (const policyFlag of input.policyFlags) flags.push(`critic: ${policyFlag}`);

  const footageRecentlyUsed = input.footage.usedCount > 0;

  // A licensed stock clip whose photographer or page did not survive into
  // the export cannot be licence-checked by the reviewer, which is the one
  // thing §9 will not let an export be missing. Reported per clip, because
  // "one of eight" is the answer the reviewer needs.
  for (const part of input.footage.parts) {
    if (part.provider === null) continue;
    if (part.photographer === null || part.pageUrl === null) {
      flags.push(`${part.provider} clip ${part.providerClipId ?? "?"} at position ${part.position} has no attribution recorded`);
    }
  }

  let scriptSimilarityResult: AuditResult["scriptSimilarity"] = null;
  let flaggedAsRepeat = false;
  if (input.recentScriptBodies.length > 0) {
    let maxSimilarity = -Infinity;
    let mostSimilarIndex = -1;
    input.recentScriptBodies.forEach((body, i) => {
      const similarity = scriptSimilarity(input.script.body, body);
      if (similarity > maxSimilarity) {
        maxSimilarity = similarity;
        mostSimilarIndex = i;
      }
    });
    scriptSimilarityResult = { maxSimilarity, mostSimilarIndex };
    flaggedAsRepeat = maxSimilarity >= SCRIPT_SIMILARITY_FLAG_THRESHOLD;
    if (flaggedAsRepeat) flags.push(`script similarity ${maxSimilarity.toFixed(2)} >= ${SCRIPT_SIMILARITY_FLAG_THRESHOLD}`);
  }

  const deltaMs = input.captionEndMs - input.narrationDurationS * 1000;
  const withinTolerance = Math.abs(deltaMs) <= input.durationToleranceMs;
  if (!withinTolerance) flags.push(`captions end ${deltaMs.toFixed(0)}ms off narration audio (tolerance ${input.durationToleranceMs}ms)`);

  if (input.voiceUsedToday) flags.push("voice already used earlier today");

  // Not a failure — §5.2.5 lets RESEARCH fail without costing the day's
  // video — but the reviewer has to know which of the two kinds of script
  // they are reading before they judge its specifics.
  const ungrounded = input.research === null;
  if (ungrounded) flags.push("no research brief — script written from the signal title alone");

  if (input.edit?.degradedReason != null) flags.push(`EDIT did not run: ${input.edit.degradedReason} — clips are as sourced`);

  // Not a flag when PLAN simply chose well; a flag when the host's plan had
  // to be corrected, because that means PLAN is producing choices this pack
  // cannot honour and the video may look less deliberate than it reads.
  if (input.character !== null && input.character.adjustments.length > 0) {
    flags.push(`the host's action plan needed ${input.character.adjustments.length} correction(s)`);
  }

  return {
    schemaValid: wordCountInBounds && hasDebateQuestion,
    wordCountInBounds,
    narration: input.narration,
    narrationDowngraded,
    characterAbsentReason: input.characterAbsentReason,
    character: input.character,
    edit: input.edit,
    stages: input.stages,
    hasDebateQuestion,
    originalityScore: input.originalityScore,
    clearsOriginalityFloor,
    policyFlags: input.policyFlags,
    footage: input.footage,
    footageRecentlyUsed,
    research: input.research,
    ungrounded,
    voiceUsedToday: input.voiceUsedToday,
    scriptSimilarity: scriptSimilarityResult,
    flaggedAsRepeat,
    durationMatch: { deltaMs, withinTolerance },
    syntheticMediaDisclosureReminder: true,
    flags,
  };
}
