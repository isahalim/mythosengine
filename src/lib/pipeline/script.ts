import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execAtomic, type RawSqlClient } from "../../../db/client.ts";
import type { signals } from "../../../db/schema.ts";
import { ok, type Result } from "../result.ts";
import type { DriverError, LlmDriver } from "../drivers/types.ts";
import { assertSignalTransition } from "../state.ts";
import { ScriptResponseSchema } from "./script-schema.ts";
import { requestValidatedJson } from "./request-json.ts";
import type { ResearchBrief } from "../rag/research.ts";

const SCRIPT_MODEL = "openai/gpt-oss-120b";
const PROMPT_PATH = join(process.cwd(), "prompts", "script.v2.md");

export interface GeneratedScript {
  id: string;
  hook: string;
  body: string;
  debateQuestion: string;
  wordCount: number;
}

function loadPromptTemplate(): string {
  return readFileSync(PROMPT_PATH, "utf8");
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

  return ok({ id: scriptId, hook, body, debateQuestion, wordCount: wc });
}
