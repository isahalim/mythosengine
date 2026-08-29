import type { z } from "zod";
import { err, ok, type Result } from "../result.ts";
import type { DriverError, LlmDriver, LlmMessage } from "../drivers/types.ts";

/**
 * Shared by SCRIPT and CRITIC (both Groq JSON-mode calls, both need
 * "validate, one repair retry, else hard fail" — AGENT_PLAYBOOK.md Phase
 * 4). `req.jsonSchema` only needs to be truthy to switch Groq into JSON
 * mode (src/lib/drivers/groq.ts never sends the schema value itself) — the
 * actual expected shape is described in the prompt text, so any truthy
 * value works here.
 */
export async function requestValidatedJson<T>(
  llm: LlmDriver,
  model: string,
  systemPrompt: string,
  schema: z.ZodType<T>,
): Promise<Result<T, DriverError>> {
  const messages: LlmMessage[] = [{ role: "system", content: systemPrompt }];

  for (let attempt = 0; attempt < 2; attempt++) {
    const completion = await llm.complete({ model, messages, jsonSchema: true, maxTokens: 1024, temperature: 0.8 });
    if (!completion.ok) return completion;

    let parsed: unknown;
    try {
      parsed = JSON.parse(completion.value.content);
    } catch (cause) {
      messages.push({ role: "assistant", content: completion.value.content });
      messages.push({ role: "user", content: `That was not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}. Re-emit valid JSON only, matching the required shape — no markdown fences, no preamble.` });
      continue;
    }

    const result = schema.safeParse(parsed);
    if (result.success) return ok(result.data);

    messages.push({ role: "assistant", content: completion.value.content });
    messages.push({ role: "user", content: `That JSON failed schema validation: ${result.error.message}. Re-emit valid JSON only, matching the required shape.` });
  }

  return err({ kind: "invalid_response", message: "LLM response failed schema validation after one repair retry", retryable: false });
}
