import type { z } from "zod";
import { err, ok, type Result } from "../result.ts";
import type { DriverError, LlmDriver, LlmMessage } from "../drivers/types.ts";

/**
 * Completion budget for a JSON-mode call.
 *
 * A 130-170 word script is only ~250 tokens of JSON, so 1024 looked generous.
 * It was not: the gpt-oss models spend reasoning tokens before emitting, and
 * those count against the same ceiling. SCRIPT failed live on 2026-08-31 with
 * Groq's own words — "max completion tokens reached before generating a valid
 * document" — and the repair retry then burned a second call against the same
 * ceiling, which could never have succeeded.
 *
 * Deliberately not larger: `GroqDriver` prices a request at
 * `maxTokens + promptChars / 4` against an 8,000-token/minute bucket
 * (ARCHITECTURE.md §5.0 records what happens when a single call can consume
 * the whole bucket — `acquire()` waits for a refill that never comes, and the
 * job hangs until the Actions timeout). 3,072 leaves that headroom intact.
 */
const JSON_MAX_TOKENS = 3072;

/**
 * Groq rejecting its own model's malformed JSON, rather than a fault on our
 * side. Matched on the provider's documented error code, not on prose.
 */
function isJsonValidationFailure(error: DriverError): boolean {
  return error.kind === "provider_error" && error.message.includes("json_validate_failed");
}

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
    const completion = await llm.complete({ model, messages, jsonSchema: true, maxTokens: JSON_MAX_TOKENS, temperature: 0.8 });
    if (!completion.ok) {
      // Groq's JSON mode validates the generation server-side and rejects a
      // malformed one as HTTP 400 `json_validate_failed`. That is the model
      // failing to produce valid JSON — precisely what the repair below
      // exists for — but it arrives as a provider error and used to bypass
      // it, hard-failing the stage. Observed live on 2026-08-31: SCRIPT died
      // on a 400 whose own body said "Failed to validate JSON. Please adjust
      // your prompt."
      if (!isJsonValidationFailure(completion.error) || attempt > 0) return completion;
      messages.push({
        role: "user",
        content:
          "Your previous response was not valid JSON and was rejected before it reached me. Emit valid JSON only, matching the required shape — no markdown fences, no preamble, no commentary.",
      });
      continue;
    }

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
