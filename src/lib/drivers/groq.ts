import { fetchWithRetry } from "./http.ts";
import type { TokenBucketLimiter } from "./rate-limiter.ts";
import type { DriverError, LlmDriver, LlmRequest, LlmResponse } from "./types.ts";
import { err, ok, type Result } from "../result.ts";

const GROQ_BASE_URL = "https://api.groq.com/openai/v1/chat/completions";

interface GroqChatResponse {
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  usage?: { total_tokens?: number };
}

function isGroqChatResponse(value: unknown): value is GroqChatResponse {
  return typeof value === "object" && value !== null;
}

export interface GroqDriverOptions {
  apiKey: string;
  limiter: TokenBucketLimiter;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
}

/** Groq LLM driver (llama-3.3-70b-versatile / llama-3.1-8b-instant). */
export class GroqLlmDriver implements LlmDriver {
  private readonly baseUrl: string;
  private readonly fetchImpl?: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;

  constructor(private readonly options: GroqDriverOptions) {
    this.baseUrl = options.baseUrl ?? GROQ_BASE_URL;
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 500;
  }

  async complete(req: LlmRequest): Promise<Result<LlmResponse, DriverError>> {
    const estimatedTokens = (req.maxTokens ?? 1024) + estimatePromptTokens(req.messages);
    await this.options.limiter.acquire(estimatedTokens);

    const result = await fetchWithRetry(
      this.baseUrl,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          max_tokens: req.maxTokens,
          temperature: req.temperature,
          ...(req.jsonSchema ? { response_format: { type: "json_object" } } : {}),
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

    const res = result.value;
    const quotaRemaining = parseIntHeader(res.headers.get("x-ratelimit-remaining-requests"));

    let body: unknown;
    try {
      body = await res.json();
    } catch (cause) {
      return err({
        kind: "invalid_response",
        message: `malformed JSON from Groq: ${cause instanceof Error ? cause.message : String(cause)}`,
        retryable: false,
      });
    }

    if (!isGroqChatResponse(body)) {
      return err({ kind: "invalid_response", message: "Groq response was not an object", retryable: false });
    }

    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      return err({
        kind: "invalid_response",
        message: "Groq response had no choices[0].message.content",
        retryable: false,
      });
    }

    return ok({
      content,
      finishReason: body.choices?.[0]?.finish_reason ?? "unknown",
      quotaRemaining,
      tokensUsed: body.usage?.total_tokens ?? null,
    });
  }
}

function parseIntHeader(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function estimatePromptTokens(messages: LlmRequest["messages"]): number {
  const chars = messages.reduce((sum, m) => sum + m.content.length, 0);
  return Math.ceil(chars / 4); // rough chars-per-token heuristic, refined once real usage data exists
}
