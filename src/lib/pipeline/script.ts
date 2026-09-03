import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execAtomic, type RawSqlClient } from "../../../db/client.ts";
import type { signals } from "../../../db/schema.ts";
import { err, ok, type Result } from "../result.ts";
import type { DriverError, LlmDriver } from "../drivers/types.ts";
import { assertSignalTransition } from "../state.ts";
import { DiscourseScriptResponseSchema, type DiscourseBeat, type DiscourseScriptResponse } from "./script-schema.ts";
import { requestValidatedJson } from "./request-json.ts";
import { describeViolations, discourseWordCount, estimatedReadSeconds, flattenBeats, validateBeatStructure, type BeatStructureViolation } from "./discourse.ts";
import type { ResearchBrief } from "../rag/research.ts";
import { GROQ_REASONING_MODEL } from "../../config/models.ts";

/**
 * The default when RENDER does not name one, which is every model call this
 * stage makes if a direct caller or a test leaves it out. SCRIPT spent a few
 * hours on Gemini on 2026-09-01 and is back here — src/config/models.ts has
 * the whole story.
 */
const SCRIPT_MODEL = GROQ_REASONING_MODEL;
const DISCOURSE_PROMPT_PATH = join(process.cwd(), "prompts", "script.v3.md");

export interface GeneratedScript {
  id: string;
  hook: string;
  body: string;
  debateQuestion: string;
  wordCount: number;
  /**
   * The discourse beats. Everything downstream that only needs the words
   * reads `body`, which carries the spoken narration; `beats` is for the
   * stages that vary on `move` — caption emphasis and where the footage
   * cuts.
   */
  beats: DiscourseBeat[];
  targetDurationS: number;
  /**
   * Advisory gate findings the draft was accepted with — in practice a
   * length estimate outside the ±25% band (discourse.ts).
   *
   * Empty on a clean draft. Never a reason to fail: AUDIT SUMMARY flags the
   * same miss on the operator's review surface from the same ruler, so this
   * is here for the render log, not as a second gate.
   */
  structureNotes: string[];
}

function loadDiscoursePromptTemplate(): string {
  return readFileSync(DISCOURSE_PROMPT_PATH, "utf8");
}

/**
 * The research block as the drafting prompt sees it. Deliberately plain
 * text, not JSON: the model is being asked to write from it, not to parse
 * it, and prose costs fewer tokens than a re-serialized object.
 *
 * An absent brief renders as an explicit "no research available" line
 * rather than an empty block — prompt v2 has a rule for that case, and a
 * silently blank section reads to a model like an oversight it should fill
 * in from memory, which is the exact failure this stage exists to stop.
 */
export function formatResearchBrief(brief: ResearchBrief | null): string {
  if (!brief) return "No research was available for this topic. Write from the signal alone (rule 5).";

  const points = brief.keyPoints.map((point) => `- ${point}`).join("\n");
  const sources = brief.citations.map((c) => `- ${c.claim} [${c.sourceKind}: ${c.title}]`).join("\n");
  return `${brief.summary}\n\nKey points:\n${points}\n\nWhat each source supports:\n${sources}`;
}

/** A draft and what the gate found wrong with it. */
interface EvaluatedDraft {
  draft: DiscourseScriptResponse;
  violations: BeatStructureViolation[];
}

/**
 * Which of two drafts to keep.
 *
 * Fewest fatal violations wins, because a lecture is not improved by being
 * the right length. Among drafts equally acceptable on structure, the one
 * whose estimated read time lands closest to the target wins — that is the
 * only thing the length estimate is good enough to decide, and it is a
 * ranking rather than a gate.
 */
function betterDraft(a: EvaluatedDraft, b: EvaluatedDraft, targetDurationS: number): EvaluatedDraft {
  const fatalA = a.violations.filter((violation) => violation.severity === "fatal").length;
  const fatalB = b.violations.filter((violation) => violation.severity === "fatal").length;
  if (fatalA !== fatalB) return fatalA < fatalB ? a : b;

  const missA = Math.abs(estimatedReadSeconds(a.draft) - targetDurationS);
  const missB = Math.abs(estimatedReadSeconds(b.draft) - targetDurationS);
  return missB < missA ? b : a;
}

/**
 * How many times the structural gate may send a draft back.
 *
 * Two total attempts, not more. `requestValidatedJson` already spends up to
 * two calls of its own repairing malformed JSON, so a third structural round
 * could cost six Groq calls for one script — against an 8K-tokens/minute
 * bucket that SCRIPT shares with CRITIC and metadata. A model that has been
 * told twice, in specific terms, that it never wrote a `pushback` is not
 * going to discover one on the third ask; that is a prompt bug to fix in
 * script.v3.md, not a retry to pay for.
 */
const STRUCTURE_ATTEMPTS = 2;

/**
 * SCRIPT, v2 discourse format (plan v2 §4) — one host, argued in beats.
 *
 * The prompt receives the signal title and the RESEARCH brief, and nothing
 * else — still no general "what you know about X", because everything in the
 * research block traces to a signal this system ingested and cited. A null
 * brief is a supported state: RESEARCH is allowed to fail (see
 * scripts/pipeline/render.ts), and the day's video ships written from the
 * title alone with the audit package saying so.
 *
 * The shape is `{move, text}` beats; the gate is `validateBeatStructure`,
 * which enforces the one thing that makes this a discourse rather than a
 * lecture — she has to be wrong before she is right.
 *
 * **Only a fatal violation can fail this stage**, and only after both
 * attempts. Shipping a lecture would be shipping the exact format this plan
 * exists to replace, so the structural rule keeps its teeth. The length
 * estimate does not have teeth and never should have: on 2026-09-03 a
 * finished render died on `118s is over the 113s ceiling for a 90s video`,
 * a 4% miss measured by a ruler discourse.ts itself calls untrusted, and it
 * took a completed RESEARCH brief and the day's video down with it. A draft
 * whose only remaining complaint is its length is accepted and reported in
 * `structureNotes`; AUDIT SUMMARY flags the same miss for the operator.
 *
 * The row this writes reads like any other. `body` holds the flattened
 * narration — the same string TTS is handed — so AUDIT SUMMARY's
 * near-duplicate check, the export package, and the console's review queue
 * all keep working without learning what a beat is.
 */
export async function generateDiscourseScript(
  rawClient: RawSqlClient,
  signal: Pick<typeof signals.$inferSelect, "id" | "title">,
  llm: LlmDriver,
  targetDurationS: number,
  research: ResearchBrief | null = null,
  now: () => number = Date.now,
  promptTemplate: string = loadDiscoursePromptTemplate(),
  traceId: string | null = null,
  model: string = SCRIPT_MODEL,
): Promise<Result<GeneratedScript, DriverError>> {
  const basePrompt = promptTemplate
    .replace("{{signal_title_and_summary}}", signal.title)
    .replace("{{research_brief}}", formatResearchBrief(research))
    .replace("{{target_duration_s}}", String(targetDurationS));

  const attemptDraft = async (systemPrompt: string): Promise<Result<EvaluatedDraft, DriverError>> => {
    const validated = await requestValidatedJson(llm, model, systemPrompt, DiscourseScriptResponseSchema);
    if (!validated.ok) return validated;
    return ok({ draft: validated.value, violations: validateBeatStructure(validated.value, targetDurationS) });
  };

  const first = await attemptDraft(basePrompt);
  if (!first.ok) return first;

  // `last` is what the retry is told about; `best` is what is kept. They
  // differ whenever a rewrite trades one fault for another — the live
  // 2026-09-03 run wrote a draft under the floor, then one over the ceiling,
  // and the old loop scored only the second, so the closer of the two was
  // discarded before anything looked at it.
  let last = first.value;
  let best = first.value;

  for (let retry = 1; retry < STRUCTURE_ATTEMPTS && last.violations.length > 0; retry++) {
    const next = await attemptDraft(
      `${basePrompt}\n\n<previous_attempt_rejected>Your last draft was rejected by the structural gate:\n${describeViolations(last.violations)}\n\nRewrite it. Keep the angle and the research grounding; fix the structure.</previous_attempt_rejected>`,
    );
    if (!next.ok) return next;
    last = next.value;
    best = betterDraft(best, next.value, targetDurationS);
  }

  const fatal = best.violations.filter((violation) => violation.severity === "fatal");
  if (fatal.length > 0) {
    return err({
      kind: "invalid_response",
      message: `script failed the discourse structure gate after ${STRUCTURE_ATTEMPTS} attempts:\n${describeViolations(fatal)}`,
      retryable: false,
    });
  }

  const draft = best.draft;
  const structureNotes = best.violations.map((violation) => violation.message);
  const body = flattenBeats(draft);
  const wc = discourseWordCount(draft);
  const scriptId = crypto.randomUUID();
  const nowIso = new Date(now()).toISOString();

  assertSignalTransition("scored", "scripted");

  await execAtomic(rawClient, [
    {
      sql: `INSERT INTO scripts (id, signal_id, hook, body, debate_question, word_count, status, trace_id, beats, target_duration_s, created_at) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
      params: [scriptId, signal.id, draft.hook, body, draft.open_question, wc, traceId, JSON.stringify(draft.beats), targetDurationS, nowIso],
    },
    { sql: `UPDATE signals SET state = 'scripted' WHERE id = ?`, params: [signal.id] },
  ]);

  return ok({
    id: scriptId,
    hook: draft.hook,
    body,
    debateQuestion: draft.open_question,
    wordCount: wc,
    beats: draft.beats,
    targetDurationS,
    structureNotes,
  });
}
