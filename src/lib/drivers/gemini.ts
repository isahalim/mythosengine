import { fetchWithRetry } from "./http.ts";
import type { TokenBucketLimiter } from "./rate-limiter.ts";
import type { DriverError, LlmDriver, LlmMessage, LlmRequest, LlmResponse, ToolCall } from "./types.ts";
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
 * docs and then verified against the live endpoint rather than recalled.
 */
const GEMINI_INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";

interface GeminiStepContent {
  type?: string;
  text?: string;
}

interface GeminiStep {
  type?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  status?: string;
  content?: GeminiStepContent[];
}

interface GeminiInteractionResponse {
  status?: string;
  steps?: GeminiStep[];
  usage?: { total_tokens?: number };
  error?: { message?: string; code?: string };
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
 * Builds the `input` array.
 *
 * **Why an array and not the flat string this driver used to send.** A
 * single-turn request genuinely can take `input: "some prompt"`, and that is
 * still what a plain SCRIPT or PLAN call sends. A *tool* conversation
 * cannot: Gemini's own steps have to come back verbatim, so the moment
 * there is history the input becomes a list of typed items.
 *
 * The three item shapes, all verified against the live endpoint on
 * 2026-09-01:
 *
 *   user text     `{type: "user_input", content: [{type: "text", text}]}`
 *   a tool call   the response's own `function_call` step, echoed unchanged
 *   a tool result `{type: "function_result", call_id, name, result}`
 *
 * **The `thought` steps have to be echoed too**, which is the part that is
 * not guessable and the reason `LlmMessage.providerSteps` exists. A request
 * that reconstructs an assistant turn from `content` + `toolCalls` — all
 * this interface carried before — is rejected with a bare
 * `invalid_request`, no indication that a signature is missing. Measured
 * both ways: echoing `steps` verbatim succeeds, dropping the `thought` step
 * fails.
 */
function buildInput(messages: readonly LlmMessage[]): unknown[] {
  const input: unknown[] = [];
  // A `function_result` names the function as well as the call it answers,
  // and an `LlmMessage` of role "tool" carries only the call id. The name is
  // recovered from the assistant turn that made the call, which is always
  // earlier in the same list.
  const callNames = new Map<string, string>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) callNames.set(call.id, call.name);
  }

  for (const message of messages) {
    if (message.role === "tool") {
      const callId = message.toolCallId ?? "";
      input.push({
        type: "function_result",
        call_id: callId,
        name: callNames.get(callId) ?? callId,
        result: message.content,
      });
      continue;
    }

    if (message.role === "assistant") {
      // The provider's own steps, straight back. Never reconstructed from
      // `toolCalls`: see the note above about signatures.
      if (Array.isArray(message.providerSteps)) {
        input.push(...message.providerSteps);
      } else if (message.content.length > 0) {
        // An assistant turn with no provider state is one this driver did
        // not produce — a repair prompt's echo of a previous answer, say.
        // There is no signature to preserve, so plain text is correct.
        input.push({ type: "user_input", content: [{ type: "text", text: `[assistant]\n${message.content}` }] });
      }
      continue;
    }

    // `system` and `user` both arrive as user input. Interactions has no
    // separate system role, and labelling the system prompt as one would be
    // inventing a field; the prompt files already read as instructions.
    input.push({ type: "user_input", content: [{ type: "text", text: message.content }] });
  }

  return input;
}

/** Rough chars-per-token floor for the limiter, matching `groq.ts`'s estimator — messages **and** tool schemas, which are re-sent every turn. */
function estimatePromptTokens(messages: readonly LlmMessage[], tools: LlmRequest["tools"]): number {
  const messageChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  const providerChars = messages.reduce((sum, m) => sum + (m.providerSteps === undefined ? 0 : JSON.stringify(m.providerSteps).length), 0);
  const toolChars = tools ? JSON.stringify(tools).length : 0;
  return Math.ceil((messageChars + providerChars + toolChars) / 4);
}

/**
 * Reads the tool calls out of a response's steps.
 *
 * `arguments` arrives as a parsed **object**, where Groq sends a JSON
 * *string*. `ToolCall.argumentsJson` is the shared shape, so this
 * re-serializes rather than leaking the difference into every caller — the
 * research loop parses one field the same way whichever provider answered.
 */
function readToolCalls(steps: readonly GeminiStep[]): ToolCall[] | undefined {
  const calls = steps
    .filter((step) => step.type === "function_call" && typeof step.name === "string" && typeof step.id === "string")
    .map((step) => ({
      id: step.id as string,
      name: step.name as string,
      argumentsJson: JSON.stringify(step.arguments ?? {}),
    }));
  return calls.length > 0 ? calls : undefined;
}

/**
 * Gemini LLM driver — the reasoning provider for RESEARCH, SCRIPT and PLAN
 * (operator direction, 2026-09-01).
 *
 * Splitting work across two providers is what makes a multi-video run
 * affordable at all, and the split is not arbitrary: Gemini's free tier is
 * 5 requests/minute and 250K tokens/day **per model**, Groq's binding limit
 * is tokens-per-day, so the two ceilings are spent independently rather
 * than competing. CRITIC deliberately stays on Groq — a critic sharing a
 * model with the writer it judges is grading its own work.
 *
 * Tool calling is implemented here as of 2026-09-01. It previously refused
 * tools outright and routed RESEARCH to Groq; RESEARCH now runs here, which
 * is why `providerSteps` had to exist.
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
    await this.options.limiter.acquire((req.maxTokens ?? 1024) + estimatePromptTokens(req.messages, req.tools));

    // A single prompt with no history still goes as a plain string — the
    // shape this driver has always sent for SCRIPT and PLAN, and the one
    // fewest things can be wrong about.
    const onlyPrompt = req.messages.length === 1 && req.messages[0].role !== "tool";
    const input: unknown = onlyPrompt ? req.messages[0].content : buildInput(req.messages);

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
          // Flat, unlike Groq's `{type, function: {...}}` nesting. Verified
          // against the live endpoint: a nested declaration is rejected.
          ...(req.tools && req.tools.length > 0
            ? { tools: req.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters })) }
            : {}),
          // `mime_type: application/json` is Gemini's equivalent of Groq's
          // `response_format: {type: json_object}`. No `schema` is sent, for
          // the same reason groq.ts sends none: the expected shape is
          // described in the prompt, and `requestValidatedJson` validates the
          // result with Zod either way.
          //
          // Never sent alongside tools: a request that both offers tools and
          // demands JSON asks the model to answer in a format a tool call
          // cannot take.
          ...(req.jsonSchema && !(req.tools && req.tools.length > 0) ? { response_format: [{ type: "text", mime_type: "application/json" }] } : {}),
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

    // Interactions answers a rejected request with HTTP 200 and an `error`
    // object, so a bad request looks like a successful call carrying no
    // steps. Read it explicitly rather than reporting "carried no
    // model_output text", which is true and useless.
    if (body.error !== undefined) {
      return err({
        kind: "invalid_response",
        message: `Gemini rejected the request (${body.error.code ?? "?"}): ${body.error.message ?? "no message"}`,
        retryable: false,
      });
    }

    const steps = body.steps ?? [];
    const toolCalls = readToolCalls(steps);

    // `steps` interleaves `thought` steps with the `model_output` we want.
    // Reading steps[0] would return reasoning text on any model that emits a
    // thought first, so the output step is selected by type, not position.
    const text = steps
      .filter((s) => s.type === "model_output")
      .flatMap((s) => s.content ?? [])
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("");

    // A tool-calling turn legitimately has no output text — only a response
    // with neither text nor a tool call is malformed.
    if (text.length === 0 && toolCalls === undefined) {
      const seen = steps.map((s) => s.type ?? "?").join(", ") || "none";
      return err({
        kind: "invalid_response",
        message: `Gemini response carried no model_output text and no function_call (status=${body.status ?? "?"}, steps=[${seen}])`,
        retryable: false,
      });
    }

    return ok({
      content: text,
      finishReason: body.status ?? "unknown",
      ...(toolCalls ? { toolCalls } : {}),
      // The whole step list, opaque, for the caller to echo back verbatim on
      // the next turn. Signatures live in here.
      providerSteps: steps,
      modelUsed: req.model,
      quotaRemaining: null,
      tokensUsed: body.usage?.total_tokens ?? null,
    });
  }
}
