import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execAtomic, type RawSqlClient } from "../../../db/client.ts";
import type { signals } from "../../../db/schema.ts";
import { err, ok, type Result } from "../result.ts";
import type { DriverError, LlmDriver } from "../drivers/types.ts";
import { assertSignalTransition } from "../state.ts";
import { DiscourseScriptResponseSchema, ScriptResponseSchema, type DiscourseBeat, type DiscourseScriptResponse } from "./script-schema.ts";
import { requestValidatedJson } from "./request-json.ts";
import { describeViolations, discourseWordCount, flattenBeats, validateBeatStructure } from "./discourse.ts";
import type { ResearchBrief } from "../rag/research.ts";

const SCRIPT_MODEL = "openai/gpt-oss-120b";
const PROMPT_PATH = join(process.cwd(), "prompts", "script.v2.md");
const DISCOURSE_PROMPT_PATH = join(process.cwd(), "prompts", "script.v3.md");

export interface GeneratedScript {
  id: string;
  hook: string;
  body: string;
  debateQuestion: string;
  wordCount: number;
  /**
   * The discourse beats, or null for a v1 prose script. Everything
   * downstream that only needs the words reads `body`, which carries the
   * spoken narration in both formats; `beats` is for the stages that vary on
   * `move` — caption emphasis and where the footage cuts.
   */
  beats: DiscourseBeat[] | null;
  targetDurationS: number | null;
}

function loadPromptTemplate(): string {
  return readFileSync(PROMPT_PATH, "utf8");
}

function loadDiscoursePromptTemplate(): string {
  return readFileSync(DISCOURSE_PROMPT_PATH, "utf8");
}

function wordCount(hook: string, body: string, debateQuestion: string): number {
  return `${hook} ${body} ${debateQuestion}`
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
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

/**
 * SCRIPT (ARCHITECTURE.md §5.3). The prompt receives the signal's title and
 * the RESEARCH brief (§5.2.5) — and nothing else. That is the same
 * hallucination boundary as before, just drawn around a larger set of
 * *retrieved* facts rather than around the title alone: still no general
 * "what you know about X", because everything in the research block traces
 * to a signal this system ingested and cited.
 *
 * A null brief is a supported state, not an error. RESEARCH is allowed to
 * fail (see scripts/pipeline/render.ts) and the day's video still ships,
 * written from the title the way v1 did, with the audit package saying so.
 *
 * `130-170 words` is the prompt's own instruction, not enforced here as a
 * hard gate: word-count-in-bounds is one of AUDIT SUMMARY's (§9) advisory
 * checks, computed later, not a reason to fail this stage.
 */
export async function generateScript(
  rawClient: RawSqlClient,
  signal: Pick<typeof signals.$inferSelect, "id" | "title">,
  llm: LlmDriver,
  research: ResearchBrief | null = null,
  now: () => number = Date.now,
  promptTemplate: string = loadPromptTemplate(),
  /**
   * The caller's `runs.trace_id`, stamped on the row so the console's guided
   * run can attribute this script — and, through it, the render and export
   * that follow — to the run the operator is watching (db/schema.ts's
   * `scripts.trace_id`). Optional: a caller with no run context writes null
   * rather than inventing a trace.
   */
  traceId: string | null = null,
): Promise<Result<GeneratedScript, DriverError>> {
  const systemPrompt = promptTemplate
    .replace("{{signal_title_and_summary}}", signal.title)
    .replace("{{research_brief}}", formatResearchBrief(research));

  const validated = await requestValidatedJson(llm, SCRIPT_MODEL, systemPrompt, ScriptResponseSchema);
  if (!validated.ok) return validated;

  const { hook, body, debate_question: debateQuestion } = validated.value;
  const wc = wordCount(hook, body, debateQuestion);
  const scriptId = crypto.randomUUID();
  const nowIso = new Date(now()).toISOString();

  assertSignalTransition("scored", "scripted");

  await execAtomic(rawClient, [
    {
      sql: `INSERT INTO scripts (id, signal_id, hook, body, debate_question, word_count, status, trace_id, created_at) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
      params: [scriptId, signal.id, hook, body, debateQuestion, wc, traceId, nowIso],
    },
    { sql: `UPDATE signals SET state = 'scripted' WHERE id = ?`, params: [signal.id] },
  ]);

  return ok({ id: scriptId, hook, body, debateQuestion, wordCount: wc, beats: null, targetDurationS: null });
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
 * Same hallucination boundary as `generateScript`: the signal title and the
 * RESEARCH brief, and nothing else. What changes is the shape and the gate.
 * The shape is `{move, text}` beats; the gate is `validateBeatStructure`,
 * which enforces the one thing that makes this a discourse rather than a
 * lecture — she has to be wrong before she is right.
 *
 * A draft that fails the gate is sent back with the specific violations
 * quoted, once. If it fails again the stage fails: shipping a lecture would
 * be shipping the exact format this plan exists to replace, and silently
 * downgrading to the v1 prose path would hide that from the operator behind
 * a video that looks fine.
 *
 * The row this writes is readable by every v1 consumer. `body` holds the
 * flattened narration — the same string TTS is handed — so AUDIT SUMMARY's
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
): Promise<Result<GeneratedScript, DriverError>> {
  const basePrompt = promptTemplate
    .replace("{{signal_title_and_summary}}", signal.title)
    .replace("{{research_brief}}", formatResearchBrief(research))
    .replace("{{target_duration_s}}", String(targetDurationS));

  let draft: DiscourseScriptResponse | null = null;
  let lastViolations = "";

  for (let attempt = 0; attempt < STRUCTURE_ATTEMPTS; attempt++) {
    const systemPrompt =
      attempt === 0
        ? basePrompt
        : `${basePrompt}\n\n<previous_attempt_rejected>Your last draft was rejected by the structural gate:\n${lastViolations}\n\nRewrite it. Keep the angle and the research grounding; fix the structure.</previous_attempt_rejected>`;

    const validated = await requestValidatedJson(llm, SCRIPT_MODEL, systemPrompt, DiscourseScriptResponseSchema);
    if (!validated.ok) return validated;

    const violations = validateBeatStructure(validated.value, targetDurationS);
    if (violations.length === 0) {
      draft = validated.value;
      break;
    }
    lastViolations = describeViolations(violations);
  }

  if (draft === null) {
    return err({
      kind: "invalid_response",
      message: `script failed the discourse structure gate after ${STRUCTURE_ATTEMPTS} attempts:\n${lastViolations}`,
      retryable: false,
    });
  }

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
  });
}
