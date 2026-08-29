import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execAtomic, type RawSqlClient } from "../../../db/client.ts";
import type { scripts, signals } from "../../../db/schema.ts";
import { ok, type Result } from "../result.ts";
import type { DriverError, LlmDriver } from "../drivers/types.ts";
import { assertSignalTransition } from "../state.ts";
import { CriticResponseSchema } from "./script-schema.ts";
import { requestValidatedJson } from "./request-json.ts";

const CRITIC_MODEL = "openai/gpt-oss-120b";
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
