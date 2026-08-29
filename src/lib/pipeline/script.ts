import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execAtomic, type RawSqlClient } from "../../../db/client.ts";
import type { signals } from "../../../db/schema.ts";
import { ok, type Result } from "../result.ts";
import type { DriverError, LlmDriver } from "../drivers/types.ts";
import { assertSignalTransition } from "../state.ts";
import { ScriptResponseSchema } from "./script-schema.ts";
import { requestValidatedJson } from "./request-json.ts";

const SCRIPT_MODEL = "openai/gpt-oss-120b";
const PROMPT_PATH = join(process.cwd(), "prompts", "script.v1.md");

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
 * SCRIPT (ARCHITECTURE.md §5.3). The prompt receives the signal's title and
 * nothing else — no general "what you know about X" — same
 * hallucination-boundary discipline as every other Groq call in this repo.
 * `130-170 words` is the prompt's own instruction, not enforced here as a
 * hard gate: word-count-in-bounds is one of AUDIT SUMMARY's (§9) advisory
 * checks, computed later, not a reason to fail this stage.
 */
export async function generateScript(
  rawClient: RawSqlClient,
  signal: Pick<typeof signals.$inferSelect, "id" | "title">,
  llm: LlmDriver,
  now: () => number = Date.now,
  promptTemplate: string = loadPromptTemplate(),
): Promise<Result<GeneratedScript, DriverError>> {
  const systemPrompt = promptTemplate.replace("{{signal_title_and_summary}}", signal.title);

  const validated = await requestValidatedJson(llm, SCRIPT_MODEL, systemPrompt, ScriptResponseSchema);
  if (!validated.ok) return validated;

  const { hook, body, debate_question: debateQuestion } = validated.value;
  const wc = wordCount(hook, body, debateQuestion);
  const scriptId = crypto.randomUUID();
  const nowIso = new Date(now()).toISOString();

  assertSignalTransition("scored", "scripted");

  await execAtomic(rawClient, [
    {
      sql: `INSERT INTO scripts (id, signal_id, hook, body, debate_question, word_count, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?)`,
      params: [scriptId, signal.id, hook, body, debateQuestion, wc, nowIso],
    },
    { sql: `UPDATE signals SET state = 'scripted' WHERE id = ?`, params: [signal.id] },
  ]);

  return ok({ id: scriptId, hook, body, debateQuestion, wordCount: wc });
}
