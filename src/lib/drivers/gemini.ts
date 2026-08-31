import { fetchWithRetry } from "./http.ts";
import type { TokenBucketLimiter } from "./rate-limiter.ts";
import type { DriverError, LlmDriver, LlmMessage, LlmRequest, LlmResponse } from "./types.ts";
import { err, ok, type Result } from "../result.ts";

/**
 * The Interactions endpoint, not `:generateContent`.
 *
 * Google replaced the generateContent request/response shape with
 * Interactions in the May 2026 breaking change: `response_modalities` became
 * `response_format`, and the response became `steps[]` rather than
 * `candidates[]`. Writing this against the older shape would have compiled,
 * passed a mock test built from the same wrong memory, and failed only
 * against the live API — so the shape here was read from Google's current
 * docs rather than recalled.
 */
const GEMINI_INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";

interface GeminiStepContent {
  type?: string;
  text?: string;
}

interface GeminiStep {
  type?: string;
  status?: string;
  content?: GeminiStepContent[];
}

interface GeminiInteractionResponse {
  status?: string;
  steps?: GeminiStep[];
  usage?: { total_tokens?: number };
}

function isGeminiInteractionResponse(value: unknown): value is GeminiInteractionResponse {
  return typeof value === "object" && value !== null;
}

export interface GeminiDriverOptions {
  apiKey: string;
  limiter: TokenBucketLimiter;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
}

/**
 * Every message flattened into the one `input` string Interactions takes.
 *
 * Gemini has no `messages` array with roles the way the OpenAI-compatible
 * shape does, so the roles are rendered as labelled sections. This is lossy
 * and deliberately so: the only callers are SCRIPT and PLAN, which send a
 * single system prompt and — on a repair retry — a short user correction.
 * Nothing here carries a tool-calling conversation, and `complete()` refuses
 * one outright rather than pretending to flatten it.
 */
function flattenMessages(messages: readonly LlmMessage[]): string {
  if (messages.length === 1) return messages[0].content;
  return messages.map((m) => `[${m.role}]\n${m.content}`).join("\n\n");
}

/**
 * Gemini LLM driver, for the stages where the reasoning is the hard part —
 * SCRIPT (a self-argument that stays coherent) and PLAN (deciding what a
 * shot should show). Plan v2 §6.
 *
 * Splitting work across two providers is what makes a multi-video run
 * affordable at all: Groq's binding limit is tokens-per-day, Gemini's is
 * requests-per-minute, so the two ceilings are spent independently rather
 * than competing.
 *
 * **Tool calling is not implemented**, and that is a decision rather than an
 * omission. RESEARCH is the only tool-calling stage in this system and it
 * stays on Groq, where its BM25 tool loop is already built and tested
 * (ARCHITECTURE.md §5.2.5). A request carrying tools is refused with a typed
 * error, because silently dropping them would produce a confident answer
 * from a model that never got to look anything up.
 */
export class GeminiLlmDriver implements LlmDriver {
  private readonly baseUrl: string;
  private readonly fetchImpl?: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;

  constructor(private readonly options: GeminiDriverOptions) {
    this.baseUrl = options.baseUrl ?? GEMINI_INTERACTIONS_URL;
    this.fetchImpl = options.fetchImpl;
    // Longer than Groq's 10s: these are the long-form generation calls, and a
    // 180-second script is a lot of output tokens to wait on.
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 500;
  }

  async complete(req: LlmRequest): Promise<Result<LlmResponse, DriverError>> {
    if (req.tools && req.tools.length > 0) {
      return err({
        kind: "invalid_response",
        message: "GeminiLlmDriver does not implement tool calling — route tool-using stages (RESEARCH) to the Groq driver",
        retryable: false,
      });
    }

    const input = flattenMessages(req.messages);
    await this.options.limiter.acquire((req.maxTokens ?? 1024) + Math.ceil(input.length / 4));

    const result = await fetchWithRetry(
      this.baseUrl,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": this.options.apiKey,
        },
        body: JSON.stringify({
          model: req.model,
          input,
          // `mime_type: application/json` is Gemini's equivalent of Groq's
          // `response_format: {type: json_object}`. No `schema` is sent, for
          // the same reason groq.ts sends none: the expected shape is
          // described in the prompt, and `requestValidatedJson` validates the
          // result with Zod either way.
          ...(req.jsonSchema ? { response_format: [{ type: "text", mime_type: "application/json" }] } : {}),
          ...(req.maxTokens !== undefined || req.temperature !== undefined
            ? {
                generation_config: {
                  ...(req.maxTokens !== undefined ? { max_output_tokens: req.maxTokens } : {}),
                  ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
                },
              }
            : {}),
        }),
      },
      {
        timeoutMs: this.timeoutMs,
        maxAttempts: this.maxAttempts,
        baseDelayMs: this.baseDelayMs,
        fetchImpl: this.fetchImpl,
      },
    );

    if (!result.ok) return result;

    let body: unknown;
    try {
      body = await result.value.json();
    } catch (cause) {
      return err({
        kind: "invalid_response",
        message: `malformed JSON from Gemini: ${cause instanceof Error ? cause.message : String(cause)}`,
        retryable: false,
      });
    }

    if (!isGeminiInteractionResponse(body)) {
      return err({ kind: "invalid_response", message: "Gemini response was not an object", retryable: false });
    }

    // `steps` interleaves `thought` steps with the `model_output` we want.
    // Reading steps[0] would return reasoning text on any model that emits a
    // thought first, so the output step is selected by type, not position.
    const outputSteps = (body.steps ?? []).filter((s) => s.type === "model_output");
    const text = outputSteps
      .flatMap((s) => s.content ?? [])
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("");

    if (text.length === 0) {
      const seen = (body.steps ?? []).map((s) => s.type ?? "?").join(", ") || "none";
      return err({
        kind: "invalid_response",
        message: `Gemini response carried no model_output text (status=${body.status ?? "?"}, steps=[${seen}])`,
        retryable: false,
      });
    }

    return ok({
      content: text,
      finishReason: body.status ?? "unknown",
      quotaRemaining: null,
      tokensUsed: body.usage?.total_tokens ?? null,
    });
  }
}
