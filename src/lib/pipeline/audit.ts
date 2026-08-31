import { hammingDistance, simhash64 } from "../ingest/simhash.ts";

/**
 * AUDIT SUMMARY (ARCHITECTURE.md §9) — the same checks the old POLICY GATE
 * ran, computed the same deterministic way, but advisory only. Nothing here
 * blocks a render from reaching EXPORT; every result is a flag for the
 * human reviewer, not a rejection. Pure function, no DB/network access, no
 * model call.
 */

export interface FootageProvenance {
  segmentId: string;
  footageSourceId: string;
  sourceVideoId: string;
  clipStartS: number;
  clipEndS: number;
  usedCount: number;
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

export interface AuditSummaryInput {
  script: { hook: string; body: string; debateQuestion: string; wordCount: number };
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
const MIN_WORD_COUNT = 130;
const MAX_WORD_COUNT = 170;

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

  const wordCountInBounds = input.script.wordCount >= MIN_WORD_COUNT && input.script.wordCount <= MAX_WORD_COUNT;
  if (!wordCountInBounds) flags.push(`word count ${input.script.wordCount} outside ${MIN_WORD_COUNT}-${MAX_WORD_COUNT}`);

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

  return {
    schemaValid: wordCountInBounds && hasDebateQuestion,
    wordCountInBounds,
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
