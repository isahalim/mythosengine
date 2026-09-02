import type { DriverError, LlmDriver, LlmRequest, LlmResponse } from "./types.ts";
import { err, ok, type Result } from "../result.ts";

/**
 * The Gemini model ladder: 3.7 Flash, then 3.6, then 3.5, then 3.5 Lite.
 *
 * **This is a budget multiplier, not just a failover.** The operator's own
 * AI Studio rate-limit page (read 2026-09-01) shows the free tier metering
 * each text model separately — 5 requests/minute and 250K tokens/day for
 * 3.7 Flash, and another 5/250K for 3.6, and another for 3.5, with 3.5
 * Flash Lite getting 15/minute. So a run that exhausts 3.7 has not
 * exhausted Gemini; it has exhausted one quarter of it. Dropping a rung
 * buys a fresh per-minute allowance *and* a fresh daily one, which is why
 * this is worth more than a sleep.
 *
 * The order is capability-first and deliberately so: every rung can do
 * these jobs, and the higher ones do them better, so the ladder is only
 * ever descended under pressure and always starts back at the top on the
 * next call.
 *
 * **What counts as pressure.** Only rate limiting and quota exhaustion move
 * the ladder. A malformed response, a schema failure or a bad request is
 * the *same* on the next model down — retrying those on 3.6 would spend a
 * second model's budget to receive the same answer, and would turn one
 * clear error into four confusing ones. Those return immediately.
 *
 * Per the operator's direction, a rate limit is first waited out once on
 * the current model (the per-minute window is 60 seconds and the model is
 * the better one), and only a second failure drops a rung.
 */

/**
 * Verified present on this account, 2026-09-01, by listing
 * `v1beta/models` — not recalled. A model id that does not exist fails
 * every call on that rung and silently costs the ladder a quarter of its
 * budget, so these are checked rather than assumed.
 */
export const GEMINI_MODEL_LADDER = ["gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"] as const;

export type GeminiModel = (typeof GEMINI_MODEL_LADDER)[number];

/**
 * How long to wait out a per-minute limit before dropping a rung.
 *
 * 61 seconds, not 60: the window is measured by the provider and a request
 * sent at exactly the boundary is a coin flip. One second of margin costs
 * nothing on a stage that has already decided to wait a minute.
 */
const RPM_WINDOW_MS = 61_000;

export interface GeminiLadderOptions {
  /** Overridable so tests do not wait a real minute. */
  sleep?: (ms: number) => Promise<void>;
  models?: readonly string[];
  /** Called when the ladder waits or drops, so a run's log says why it slowed down. */
  onEvent?: (event: string) => void;
}

function isExhaustion(error: DriverError): boolean {
  if (error.kind === "rate_limited") return true;
  // Interactions reports a spent daily allowance as a provider error whose
  // body names the quota; there is no distinct error kind for it.
  return error.kind === "provider_error" && /quota|rate.?limit|resource.?exhausted|429/i.test(error.message);
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wraps a Gemini driver so `complete()` walks the ladder.
 *
 * `req.model` is *ignored* — the ladder owns model selection, and a caller
 * naming its own would opt out of the whole budget argument above. Stages
 * pass a placeholder; `LlmResponse.modelUsed` reports which rung answered,
 * and the audit package records it.
 */
export class GeminiLadderDriver implements LlmDriver {
  private readonly models: readonly string[];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onEvent: (event: string) => void;

  constructor(
    private readonly inner: LlmDriver,
    options: GeminiLadderOptions = {},
  ) {
    this.models = options.models ?? GEMINI_MODEL_LADDER;
    this.sleep = options.sleep ?? defaultSleep;
    this.onEvent = options.onEvent ?? ((event) => console.warn(event));
  }

  async complete(req: LlmRequest): Promise<Result<LlmResponse, DriverError>> {
    let lastError: DriverError | undefined;

    for (let rung = 0; rung < this.models.length; rung++) {
      const model = this.models[rung];

      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await this.inner.complete({ ...req, model });
        if (result.ok) return ok({ ...result.value, modelUsed: model });

        lastError = result.error;

        // Not a quota problem. The next model down would answer the same
        // way, so stop here and report the real failure.
        if (!isExhaustion(result.error)) return result;

        // First strike on this rung: wait out the per-minute window and try
        // the better model again rather than immediately settling for a
        // weaker one.
        if (attempt === 0) {
          const waitMs = result.error.retryAfterMs ?? RPM_WINDOW_MS;
          this.onEvent(`GEMINI: ${model} is rate limited — waiting ${(waitMs / 1000).toFixed(0)}s for its window to reset.`);
          await this.sleep(waitMs);
          continue;
        }

        // Second strike: this model's minute (or its day) is genuinely
        // spent. Drop to the next rung's separate budget.
        const next = this.models[rung + 1];
        if (next !== undefined) this.onEvent(`GEMINI: ${model} still exhausted after a full window — dropping to ${next}.`);
      }
    }

    return err({
      kind: "rate_limited",
      message: `every Gemini model on the ladder (${this.models.join(", ")}) was exhausted: ${lastError?.message ?? "no error recorded"}`,
      retryable: true,
    });
  }
}

/**
 * Runs `stage` on Gemini, falling back to Groq if the whole ladder is spent.
 *
 * The fallback is the reason a bad quota day costs this system quality
 * rather than a video. RESEARCH, SCRIPT and PLAN moved to Gemini for its
 * reasoning; none of them stopped being possible on Groq, which is what
 * they ran on until 2026-09-01. Which provider actually answered is
 * returned so the audit package can say so — a script silently written by
 * the fallback model, presented as though it came from the primary, is
 * exactly the kind of unrecorded degradation the audit package exists to
 * prevent.
 */
export async function withGroqFallback<T>(
  stage: string,
  gemini: LlmDriver,
  groq: LlmDriver,
  run: (llm: LlmDriver, model: string) => Promise<Result<T, DriverError>>,
  groqModel: string,
  onEvent: (event: string) => void = (event) => console.warn(event),
): Promise<{ result: Result<T, DriverError>; provider: "gemini" | "groq"; fallbackReason: string | null }> {
  const primary = await run(gemini, LADDER_PLACEHOLDER_MODEL);
  if (primary.ok) return { result: primary, provider: "gemini", fallbackReason: null };

  // Only exhaustion falls back. A schema failure or a malformed answer is a
  // problem with the request, and asking a different provider the same bad
  // question wastes a second budget to get a second bad answer.
  if (!isExhaustion(primary.error)) return { result: primary, provider: "gemini", fallbackReason: null };

  const reason = `${primary.error.kind}: ${primary.error.message}`;
  onEvent(`${stage}: Gemini exhausted (${reason}) — falling back to Groq ${groqModel}.`);
  const secondary = await run(groq, groqModel);
  return { result: secondary, provider: "groq", fallbackReason: reason };
}

/**
 * What stages pass as `model` when they call through the ladder.
 *
 * The ladder overrides it, so the value is never sent; it exists so the
 * call site reads honestly rather than naming one rung it does not
 * actually pin.
 */
export const LADDER_PLACEHOLDER_MODEL = "gemini-ladder";
