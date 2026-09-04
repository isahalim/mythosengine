import { describe, expect, it } from "vitest";
import { LadderLlmDriver, type LadderRung } from "./llm-ladder.ts";
import { createEditLadder, createGroqReasoningLadder, createReasoningLadders } from "./resolve-ladder.ts";
import { EDIT_FALLBACK_MODEL, EDIT_MODEL, GEMINI_REASONING_MODEL, GROQ_LIGHT_MODEL, GROQ_REASONING_MODEL } from "../../config/models.ts";
import type { DriverError, LlmDriver, LlmRequest } from "./types.ts";
import { err, ok } from "../result.ts";

/** Records every model it is asked for. `fail` decides which of them error. */
function recording(asked: string[], fail: (model: string) => DriverError | null): LlmDriver {
  return {
    complete: (req: LlmRequest) => {
      asked.push(req.model);
      const failure = fail(req.model);
      return Promise.resolve(
        failure === null ? ok({ content: `answered by ${req.model}`, finishReason: "completed", quotaRemaining: null, tokensUsed: 1 }) : err(failure),
      );
    },
  };
}

const rateLimited: DriverError = { kind: "rate_limited", message: "429", retryable: true };
const serverError: DriverError = { kind: "provider_error", message: "500 InternalServerError", retryable: true };

function rung(provider: "gemini" | "groq", model: string, llm: LlmDriver): LadderRung {
  return { provider, model, llm };
}

const request: LlmRequest = { model: "ignored-by-the-ladder", messages: [{ role: "system", content: "hi" }] };

describe("LadderLlmDriver", () => {
  it("answers on the top rung and never touches the ones below", async () => {
    const asked: string[] = [];
    const llm = recording(asked, () => null);
    const ladder = new LadderLlmDriver([rung("gemini", "top", llm), rung("groq", "middle", llm), rung("groq", "bottom", llm)], () => {});

    const result = await ladder.complete(request);

    expect(result.ok).toBe(true);
    expect(asked).toEqual(["top"]);
    expect(ladder.lastUsed()).toEqual({ provider: "gemini", model: "top", fallbackReason: null });
  });

  // The caller's `model` is its default for the case where it is handed a
  // plain driver. A ladder overriding it is what stops a stage pinning
  // itself off the ladder by accident.
  it("ignores the model the caller asked for", async () => {
    const asked: string[] = [];
    const ladder = new LadderLlmDriver([rung("groq", "the-rung", recording(asked, () => null))], () => {});

    await ladder.complete({ ...request, model: "something-else" });

    expect(asked).toEqual(["the-rung"]);
  });

  // The whole reason this class exists. `withGroqFallback` fell back only on
  // quota exhaustion, so the two 500s the 2026-09-01 run drew went straight
  // through it and killed the render at SCRIPT.
  it.each([
    ["a rate limit", rateLimited],
    ["a 500", serverError],
    ["a timeout", { kind: "timeout", message: "timed out", retryable: true } as DriverError],
    ["a malformed body", { kind: "invalid_response", message: "not JSON", retryable: false } as DriverError],
  ])("steps down on %s, not just on exhaustion", async (_label, failure) => {
    const asked: string[] = [];
    const llm = recording(asked, (model) => (model === "top" ? failure : null));
    const ladder = new LadderLlmDriver([rung("gemini", "top", llm), rung("groq", "middle", llm)], () => {});

    const result = await ladder.complete(request);

    expect(result.ok).toBe(true);
    expect(asked).toEqual(["top", "middle"]);
  });

  it("records which rung answered and why it was not the one above", async () => {
    const llm = recording([], (model) => (model === "top" ? rateLimited : null));
    const ladder = new LadderLlmDriver([rung("gemini", "top", llm), rung("groq", "middle", llm)], () => {});

    await ladder.complete(request);

    const used = ladder.lastUsed();
    expect(used?.provider).toBe("groq");
    expect(used?.model).toBe("middle");
    // The reason a reviewer reads months later: which rung refused, and how.
    expect(used?.fallbackReason).toContain("gemini:top");
    expect(used?.fallbackReason).toContain("429");
  });

  // Sticky. A 429 is a statement about the next minute, so re-offering the
  // rung that just refused spends a request to learn the same thing twice —
  // and on a five-per-minute meter it spends the limiter's wait too.
  it("does not climb back to a rung that has already failed", async () => {
    const asked: string[] = [];
    const llm = recording(asked, (model) => (model === "top" ? rateLimited : null));
    const ladder = new LadderLlmDriver([rung("gemini", "top", llm), rung("groq", "middle", llm)], () => {});

    await ladder.complete(request);
    await ladder.complete(request);
    await ladder.complete(request);

    expect(asked).toEqual(["top", "middle", "middle", "middle"]);
  });

  it("reports the model that actually spoke, so the audit package cannot name the wrong one", async () => {
    const llm = recording([], (model) => (model === "top" ? serverError : null));
    const ladder = new LadderLlmDriver([rung("gemini", "top", llm), rung("groq", "middle", llm)], () => {});

    const result = await ladder.complete(request);

    expect(result.ok && result.value.modelUsed).toBe("middle");
  });

  it("returns the last rung's error, unwrapped, when every rung fails", async () => {
    const llm = recording([], (model) => (model === "bottom" ? rateLimited : serverError));
    const ladder = new LadderLlmDriver([rung("groq", "top", llm), rung("groq", "bottom", llm)], () => {});

    const result = await ladder.complete(request);

    // Unwrapped because the caller's degrade path reads `kind`, and a
    // synthetic wrapper would hide a rate limit behind a generic error.
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.kind).toBe("rate_limited");
  });

  it("keeps failing without making a request once every rung is spent", async () => {
    const asked: string[] = [];
    const llm = recording(asked, () => serverError);
    const ladder = new LadderLlmDriver([rung("groq", "only", llm)], () => {});

    await ladder.complete(request);
    const second = await ladder.complete(request);

    expect(asked).toEqual(["only"]);
    expect(second.ok).toBe(false);
  });

  // A zero-rung ladder would return a fabricated error from a stage that
  // never made a request, which reads in the audit package exactly like a
  // provider outage.
  it("refuses to be built with no rungs", () => {
    expect(() => new LadderLlmDriver([], () => {})).toThrow(/at least one rung/);
  });
});

describe("createReasoningLadders", () => {
  const groq = recording([], () => null);

  it("puts Gemini on top and the two Groq models beneath it", () => {
    const ladders = createReasoningLadders(groq, "a-key", () => {});
    expect(ladders.forStage("SCRIPT").describe()).toBe(`gemini:${GEMINI_REASONING_MODEL} -> groq:${GROQ_REASONING_MODEL} -> groq:${GROQ_LIGHT_MODEL}`);
    expect(ladders.geminiUnavailableReason).toBeNull();
  });

  // An upgrade must not become a dependency. Without the key the stage is
  // still strictly better off than it was before the ladder: SCRIPT used to
  // fail the render outright when 120b was rate-limited.
  it.each([
    ["unset", undefined],
    ["empty", ""],
  ])("drops the Gemini rung and says so when the key is %s", (_label, key) => {
    const ladders = createReasoningLadders(groq, key, () => {});
    expect(ladders.forStage("PLAN").describe()).toBe(`groq:${GROQ_REASONING_MODEL} -> groq:${GROQ_LIGHT_MODEL}`);
    expect(ladders.geminiUnavailableReason).toContain("GEMINI_API_KEY");
  });

  // Per stage, because the descent is sticky: a rate-limited rerank must not
  // decide that SCRIPT starts one rung down.
  it("hands each stage its own ladder", () => {
    const ladders = createReasoningLadders(groq, "a-key", () => {});
    expect(ladders.forStage("SCRIPT")).not.toBe(ladders.forStage("PLAN"));
  });
});

describe("createGroqReasoningLadder", () => {
  // RESEARCH has already spent its Gemini attempt on its own model and its
  // own four-turn budget before this is reached. Splicing the general
  // ladder's Gemini rung in above these two would hand that one stage a
  // second Gemini attempt — the thing ruled out on 2026-09-02.
  it("is the general ladder with no Gemini rung", () => {
    expect(createGroqReasoningLadder(recording([], () => null), "RESEARCH", () => {}).describe()).toBe(
      `groq:${GROQ_REASONING_MODEL} -> groq:${GROQ_LIGHT_MODEL}`,
    );
  });
});

describe("createEditLadder", () => {
  it("is the two qwen3 models and nothing else", () => {
    expect(createEditLadder(recording([], () => null), () => {}).describe()).toBe(`groq:${EDIT_MODEL} -> groq:${EDIT_FALLBACK_MODEL}`);
  });

  // "Fallback and continue with the rest of the work": one failure moves
  // every remaining clip to the second rung, rather than re-offering the
  // first once per clip and paying for the same refusal eight times.
  it("finishes the run on the second model once the first has failed", async () => {
    const asked: string[] = [];
    const ladder = createEditLadder(
      recording(asked, (model) => (model === EDIT_MODEL ? rateLimited : null)),
      () => {},
    );

    await ladder.complete(request);
    await ladder.complete(request);

    expect(asked).toEqual([EDIT_MODEL, EDIT_FALLBACK_MODEL, EDIT_FALLBACK_MODEL]);
  });
});
