import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execAtomic, type RawSqlClient } from "../../../db/client.ts";
import type { scripts, signals } from "../../../db/schema.ts";
import { ok, type Result } from "../result.ts";
import type { DriverError, LlmDriver } from "../drivers/types.ts";
import { assertSignalTransition } from "../state.ts";
import { CriticResponseSchema } from "./script-schema.ts";
import { requestValidatedJson } from "./request-json.ts";
import { GROQ_LIGHT_MODEL } from "../../config/models.ts";

/**
 * The lighter model (operator direction, 2026-09-03), and named from
 * `src/config/models.ts` rather than inline — this file used to spell the id
 * out itself, which is the exact thing CLAUDE.md forbids and the reason a
 * stage can drift from every other one without a test noticing.
 *
 * CRITIC is advisory: its verdict never stops a signal reaching FOOTAGE
 * SELECT, it only reaches the audit package for a human to read. Moving it
 * here also ends the compromise `src/config/models.ts` recorded — a critic
 * on the writer's own model was grading its own work, and the second
 * opinion is a second model again rather than a second prompt.
 */
const CRITIC_MODEL = GROQ_LIGHT_MODEL;
const PROMPT_PATH = join(process.cwd(), "prompts", "critic.v1.md");

export interface CriticVerdict {
  originalityScore: number;
  policyFlags: string[];
  verdict: "approved" | "rejected";
  reason: string;
}

function loadPromptTemplate(): string {
  return readFileSync(PROMPT_PATH, "utf8");
}

/**
 * CRITIC (ARCHITECTURE.md §5.4) — a separate call that never sees the
 * drafting prompt. Advisory only: a low score or a policy flag is carried
 * forward into AUDIT SUMMARY (§9) and surfaced to the human reviewer, but
 * never stops the signal from proceeding to FOOTAGE SELECT — this stage
 * itself always transitions `scripted -> critiqued` regardless of verdict.
 */
export async function critiqueScript(
  rawClient: RawSqlClient,
  script: Pick<typeof scripts.$inferSelect, "id" | "hook" | "body" | "debateQuestion">,
  signal: Pick<typeof signals.$inferSelect, "id" | "title">,
  llm: LlmDriver,
  promptTemplate: string = loadPromptTemplate(),
): Promise<Result<CriticVerdict, DriverError>> {
  const systemPrompt = promptTemplate
    .replace("{{script_json}}", JSON.stringify({ hook: script.hook, body: script.body, debate_question: script.debateQuestion }))
    .replace("{{signal_json}}", JSON.stringify({ title: signal.title }));

  const validated = await requestValidatedJson(llm, CRITIC_MODEL, systemPrompt, CriticResponseSchema);
  if (!validated.ok) return validated;

  const { originality_score: originalityScore, policy_flags: policyFlags, verdict, reason } = validated.value;

  assertSignalTransition("scripted", "critiqued");

  await execAtomic(rawClient, [
    { sql: `UPDATE scripts SET originality_score = ? WHERE id = ?`, params: [originalityScore, script.id] },
    { sql: `UPDATE signals SET state = 'critiqued' WHERE id = ?`, params: [signal.id] },
  ]);

  return ok({ originalityScore, policyFlags, verdict, reason });
}
