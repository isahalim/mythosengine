import { describe, expect, it } from "vitest";
import { GEMINI_MODEL_LADDER, GeminiLadderDriver, withGroqFallback } from "./gemini-ladder.ts";
import type { DriverError, LlmDriver, LlmRequest } from "./types.ts";
import { err, ok, type Result } from "../result.ts";

const rateLimited: DriverError = { kind: "rate_limited", message: "429", retryable: true };
const quotaSpent: DriverError = { kind: "provider_error", message: "RESOURCE_EXHAUSTED: quota exceeded for this model", retryable: true };
const badRequest: DriverError = { kind: "invalid_response", message: "Unknown parameter 'nope'", retryable: false };

/** Records which model each attempt used, and answers from a scripted list. */
function scripted(outcomes: (DriverError | "ok")[]): { driver: LlmDriver; models: string[] } {
  const models: string[] = [];
  let i = 0;
  return {
    models,
    driver: {
      complete(req: LlmRequest) {
        models.push(req.model);
        const outcome = outcomes[Math.min(i++, outcomes.length - 1)];
        if (outcome === "ok") {
          return Promise.resolve(ok({ content: "answer", finishReason: "completed", quotaRemaining: null, tokensUsed: 10 }));
        }
        return Promise.resolve(err(outcome));
      },
    },
  };
}

const noSleep = () => Promise.resolve();

describe("GeminiLadderDriver", () => {
  it("starts on the best model and stays there when it answers", async () => {
    const { driver, models } = scripted(["ok"]);
    const result = await new GeminiLadderDriver(driver, { sleep: noSleep, onEvent: () => {} }).complete({ model: "ignored", messages: [] });
    expect(result.ok).toBe(true);
    expect(models).toEqual(["gemini-3.7-flash"]);
  });

  it("reports which rung actually answered, not the model it was asked for", async () => {
    // `req.model` is deliberately ignored — the ladder owns model selection,
    // and the audit package has to record the model that really spoke.
    const { driver } = scripted(["ok"]);
    const result = await new GeminiLadderDriver(driver, { sleep: noSleep, onEvent: () => {} }).complete({ model: "gemini-ladder", messages: [] });
    expect(result.ok && result.value.modelUsed).toBe("gemini-3.7-flash");
  });

  it("waits out the per-minute window before giving up the better model", async () => {
    // A rate limit is a minute old at worst, and 3.7 is the better model:
    // dropping a rung immediately would trade quality for a wait that was
    // about to end anyway.
    const waits: number[] = [];
    const { driver, models } = scripted([rateLimited, "ok"]);
    const result = await new GeminiLadderDriver(driver, {
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
      onEvent: () => {},
    }).complete({ model: "x", messages: [] });

    expect(result.ok).toBe(true);
    expect(models).toEqual(["gemini-3.7-flash", "gemini-3.7-flash"]);
    expect(waits).toEqual([61_000]);
  });

  it("honours a provider-supplied retryAfterMs over its own guess", async () => {
    const waits: number[] = [];
    const { driver } = scripted([{ ...rateLimited, retryAfterMs: 5_000 }, "ok"]);
    await new GeminiLadderDriver(driver, {
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
      onEvent: () => {},
    }).complete({ model: "x", messages: [] });
    expect(waits).toEqual([5_000]);
  });

  it("drops a rung only after a full window has failed on the current one", async () => {
    const { driver, models } = scripted([rateLimited, rateLimited, "ok"]);
    const result = await new GeminiLadderDriver(driver, { sleep: noSleep, onEvent: () => {} }).complete({ model: "x", messages: [] });
    expect(result.ok).toBe(true);
    expect(models).toEqual(["gemini-3.7-flash", "gemini-3.7-flash", "gemini-3.6-flash"]);
  });

  it("treats a spent daily quota as exhaustion even though it arrives as a provider error", async () => {
    // Interactions has no distinct error kind for a spent daily allowance.
    const { driver, models } = scripted([quotaSpent, quotaSpent, "ok"]);
    const result = await new GeminiLadderDriver(driver, { sleep: noSleep, onEvent: () => {} }).complete({ model: "x", messages: [] });
    expect(result.ok).toBe(true);
    expect(models.at(-1)).toBe("gemini-3.6-flash");
  });

  it("returns a non-quota failure immediately instead of spending three more budgets on it", async () => {
    // A malformed request is identical on every rung. Retrying it down the
    // ladder would turn one clear error into four confusing ones.
    const { driver, models } = scripted([badRequest]);
    const result = await new GeminiLadderDriver(driver, { sleep: noSleep, onEvent: () => {} }).complete({ model: "x", messages: [] });
    expect(result.ok).toBe(false);
    expect(models).toEqual(["gemini-3.7-flash"]);
  });

  it("walks every rung before declaring the whole ladder spent", async () => {
    const { driver, models } = scripted([rateLimited]);
    const result = await new GeminiLadderDriver(driver, { sleep: noSleep, onEvent: () => {} }).complete({ model: "x", messages: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("rate_limited");
    // Two attempts on each of the four rungs.
    expect(models).toHaveLength(GEMINI_MODEL_LADDER.length * 2);
    expect(new Set(models)).toEqual(new Set(GEMINI_MODEL_LADDER));
  });

  it("descends capability-first, so a weaker model is only ever a fallback", () => {
    expect([...GEMINI_MODEL_LADDER]).toEqual(["gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"]);
  });
});

describe("withGroqFallback", () => {
  const geminiDriver = {} as LlmDriver;
  const groqDriver = {} as LlmDriver;

  it("does not touch Groq when Gemini answers", async () => {
    const seen: string[] = [];
    const outcome = await withGroqFallback(
      "SCRIPT",
      geminiDriver,
      groqDriver,
      (_llm, model): Promise<Result<string, DriverError>> => {
        seen.push(model);
        return Promise.resolve(ok("written"));
      },
      "openai/gpt-oss-120b",
      () => {},
    );
    expect(outcome.provider).toBe("gemini");
    expect(outcome.fallbackReason).toBeNull();
    expect(seen).toEqual(["gemini-ladder"]);
  });

  it("falls back to Groq when the whole ladder is spent, and says why", async () => {
    const seen: string[] = [];
    const outcome = await withGroqFallback(
      "SCRIPT",
      geminiDriver,
      groqDriver,
      (_llm, model): Promise<Result<string, DriverError>> => {
        seen.push(model);
        return Promise.resolve(seen.length === 1 ? err(rateLimited) : ok("written"));
      },
      "openai/gpt-oss-120b",
      () => {},
    );
    expect(outcome.provider).toBe("groq");
    expect(outcome.result.ok).toBe(true);
    expect(outcome.fallbackReason).toContain("rate_limited");
    expect(seen).toEqual(["gemini-ladder", "openai/gpt-oss-120b"]);
  });

  it("does not ask Groq the same bad question", async () => {
    // A schema failure is a problem with the request, not the provider.
    let calls = 0;
    const outcome = await withGroqFallback(
      "PLAN",
      geminiDriver,
      groqDriver,
      (): Promise<Result<string, DriverError>> => {
        calls++;
        return Promise.resolve(err(badRequest));
      },
      "openai/gpt-oss-20b",
      () => {},
    );
    expect(calls).toBe(1);
    expect(outcome.provider).toBe("gemini");
    expect(outcome.result.ok).toBe(false);
  });
});
