import { describe, expect, it } from "vitest";
import type { DriverError, LlmDriver, LlmRequest, LlmResponse } from "../drivers/types.ts";
import { err, ok, type Result } from "../result.ts";
import type { Retriever, RetrievedPassage } from "./retriever.ts";
import {
  GEMINI_RESEARCH_REQUEST_CEILING,
  GEMINI_RESEARCH_SEARCH_RESULTS,
  GEMINI_RESEARCH_SOURCE_CHARS,
  researchWithFallback,
  selectResearchProviders,
  type ResearchProviders,
} from "./research-provider.ts";
import { GEMINI_RESEARCH_MAX_ITERATIONS, GEMINI_RESEARCH_MODEL, GROQ_REASONING_MODEL } from "../../config/models.ts";

const PROMPT = "<role>test researcher</role><topic>{{signal_title}}</topic>";
const SIGNAL = { id: "sig1", title: "GTA VI delayed to 2027" };

function passage(id: string, title: string, url: string): RetrievedPassage {
  return { signalId: id, title, url, sourceKind: "rss", observedAt: "2026-08-30T10:00:00Z", score: 1 };
}

const corpus = [
  passage("sig1", "GTA VI delayed to 2027, Rockstar confirms", "https://news.example.com/1"),
  passage("sig2", "Analysts cut Take-Two targets after the delay", "https://news.example.com/2"),
];

const stubRetriever: Retriever = {
  search: async () => ok(corpus),
  get: async (id) => ok(corpus.find((p) => p.signalId === id) ?? null),
};

const stubArticles = {
  fetchArticle: async (url: string) => ok({ url, text: "The delay was announced on a Tuesday.", truncated: false }),
};

const GOOD_BRIEF = JSON.stringify({
  summary: "Rockstar delayed GTA VI to 2027 and the market reacted.",
  key_points: ["The delay is the second one"],
  citations: [{ signal_id: "sig1", claim: "Rockstar confirmed the 2027 window" }],
});

/** A brief whose only citation names an id retrieval never returned — `finalizeBrief` rejects it. */
const UNCITABLE_BRIEF = JSON.stringify({
  summary: "Something happened.",
  key_points: ["A thing"],
  citations: [{ signal_id: "never-retrieved", claim: "invented" }],
});

/**
 * The turns a working attempt takes: search first, then the brief.
 *
 * A brief emitted without a search is always rejected, because `seen` — the
 * trust boundary — is empty and no citation can be traced to a retrieved
 * signal. Every "this provider succeeds" stub therefore has to actually
 * retrieve something first.
 */
function searchThenBrief(brief: string): (Partial<LlmResponse> | DriverError)[] {
  return [{ toolCalls: [{ id: "c1", name: "search_discourse", argumentsJson: '{"query":"gta vi delay"}' }] }, { content: brief }];
}

function scriptedLlm(turns: (Partial<LlmResponse> | DriverError)[]): LlmDriver & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  let index = 0;
  return {
    requests,
    async complete(req): Promise<Result<LlmResponse, DriverError>> {
      requests.push(req);
      const turn = turns[Math.min(index++, turns.length - 1)];
      if ("kind" in turn) return err(turn);
      return ok({ content: "", finishReason: "stop", quotaRemaining: null, tokensUsed: null, ...turn } as LlmResponse);
    },
  };
}

/**
 * Both attempts wired to scripted drivers, bypassing `selectResearchProviders`
 * so a test never needs an API key or a real Gemini driver. The bounds are
 * the real ones; only the transport is stubbed.
 */
function providers(gemini: LlmDriver | null, groq: LlmDriver, unavailableReason: string | null = null): ResearchProviders {
  const common = { articles: stubArticles, options: { promptTemplate: PROMPT } };
  return {
    gemini: gemini === null ? null : { llm: gemini, ...common, options: { ...common.options, model: GEMINI_RESEARCH_MODEL, maxIterations: GEMINI_RESEARCH_MAX_ITERATIONS } },
    groq: { llm: groq, ...common, options: { ...common.options, model: GROQ_REASONING_MODEL } },
    unavailableReason,
  };
}

const silent = (): void => undefined;

describe("selectResearchProviders", () => {
  it("gives Gemini the bounds its intake justifies, and leaves Groq's untouched", () => {
    const selection = selectResearchProviders(scriptedLlm([]), "AIza0000000000000000000000000000000000");

    expect(selection.gemini?.options.model).toBe(GEMINI_RESEARCH_MODEL);
    // Four turns against a 5 req/min ceiling: the cap is what keeps this
    // path away from the limit that lost the 2026-09-01 render.
    expect(selection.gemini?.options.maxIterations).toBe(4);
    expect(selection.gemini?.options.requestTokenCeiling).toBe(GEMINI_RESEARCH_REQUEST_CEILING);
    expect(selection.gemini?.options.maxSearchResults).toBe(GEMINI_RESEARCH_SEARCH_RESULTS);

    // Groq keeps every default: six turns, the 7,200-token ceiling derived
    // from its real 413, and 8 search results.
    expect(selection.groq.options).toEqual({ model: GROQ_REASONING_MODEL });
    expect(selection.unavailableReason).toBeNull();
  });

  it("names the model each provider is asked for, rather than letting a stage inline one", () => {
    // CLAUDE.md: a stage that names its own model id inline fails in
    // production while every test passes. EDIT and rerank shipped
    // "gemini-ladder" that way.
    const selection = selectResearchProviders(scriptedLlm([]), "AIza0000000000000000000000000000000000");
    expect(selection.gemini?.options.model).toBe("gemini-3.7-flash");
    expect(selection.groq.options.model).toBe("openai/gpt-oss-120b");
  });

  it("reads more of each source than the Groq path can afford", () => {
    // The single largest quality difference between the two paths: 6,000
    // characters is roughly the first third of a news article.
    expect(GEMINI_RESEARCH_SOURCE_CHARS).toBeGreaterThan(6_000);
  });

  it("offers no Gemini attempt at all without a key, and says so", () => {
    const selection = selectResearchProviders(scriptedLlm([]), undefined);
    expect(selection.gemini).toBeNull();
    expect(selection.unavailableReason).toContain("GEMINI_API_KEY is not set");
  });
});

describe("researchWithFallback", () => {
  it("returns Gemini's brief without touching Groq when the attempt lands", async () => {
    const gemini = scriptedLlm(searchThenBrief(GOOD_BRIEF));
    const groq = scriptedLlm(searchThenBrief(GOOD_BRIEF));

    const outcome = await researchWithFallback(providers(gemini, groq), stubRetriever, SIGNAL, silent);

    expect(outcome.provider).toBe("gemini");
    expect(outcome.fallbackReason).toBeNull();
    expect(outcome.result.ok && outcome.result.value.citations).toHaveLength(1);
    // The point of trying Gemini first is that Groq's daily budget is not
    // spent when it works.
    expect(groq.requests).toHaveLength(0);
  });

  it("falls back on a 500, which is the exact failure withGroqFallback let through", async () => {
    // The 2026-09-01 run drew two `500 InternalServerError`s. The old
    // wrapper only fell back on quota exhaustion, so they went to the floor
    // and the render died at SCRIPT.
    const gemini = scriptedLlm([{ kind: "provider_error", message: "HTTP 500 InternalServerError", retryable: true }]);
    const groq = scriptedLlm(searchThenBrief(GOOD_BRIEF));

    const outcome = await researchWithFallback(providers(gemini, groq), stubRetriever, SIGNAL, silent);

    expect(outcome.provider).toBe("groq");
    expect(outcome.result.ok).toBe(true);
    expect(outcome.fallbackReason).toBe("provider_error: HTTP 500 InternalServerError");
    expect(groq.requests).toHaveLength(2);
  });

  it("falls back on a rate limit rather than waiting out a per-minute window", async () => {
    const gemini = scriptedLlm([{ kind: "rate_limited", message: "HTTP 429; 5 requests per minute", retryable: true }]);
    const groq = scriptedLlm(searchThenBrief(GOOD_BRIEF));

    const outcome = await researchWithFallback(providers(gemini, groq), stubRetriever, SIGNAL, silent);

    expect(outcome.provider).toBe("groq");
    expect(outcome.fallbackReason).toContain("rate_limited");
  });

  it("falls back when Gemini answers successfully but produces no citable brief", async () => {
    // Not a transport failure — a 200 carrying a brief that cites an id
    // retrieval never returned. An uncited brief is the ungrounded output
    // this stage exists to replace, so it is a fallback trigger like any
    // other.
    const gemini = scriptedLlm(searchThenBrief(UNCITABLE_BRIEF));
    const groq = scriptedLlm(searchThenBrief(GOOD_BRIEF));

    const outcome = await researchWithFallback(providers(gemini, groq), stubRetriever, SIGNAL, silent);

    expect(outcome.provider).toBe("groq");
    expect(outcome.fallbackReason).toContain("no citation traceable to a retrieved signal");
    expect(outcome.result.ok).toBe(true);
  });

  it("spends at most four Gemini requests before giving up on it", async () => {
    // Five would cross the free tier's 5 requests/minute ceiling. A model
    // that never stops calling tools is the worst case, and it must stop at
    // four.
    const gemini = scriptedLlm([{ toolCalls: [{ id: "c1", name: "search_discourse", argumentsJson: '{"query":"gta"}' }] }]);
    const groq = scriptedLlm(searchThenBrief(GOOD_BRIEF));

    const outcome = await researchWithFallback(providers(gemini, groq), stubRetriever, SIGNAL, silent);

    expect(gemini.requests).toHaveLength(GEMINI_RESEARCH_MAX_ITERATIONS);
    expect(gemini.requests).toHaveLength(4);
    expect(outcome.provider).toBe("groq");
    expect(outcome.result.ok).toBe(true);
  });

  it("asks each provider for its own model", async () => {
    const gemini = scriptedLlm([{ kind: "provider_error", message: "down", retryable: true }]);
    const groq = scriptedLlm(searchThenBrief(GOOD_BRIEF));

    await researchWithFallback(providers(gemini, groq), stubRetriever, SIGNAL, silent);

    expect(gemini.requests[0].model).toBe(GEMINI_RESEARCH_MODEL);
    expect(groq.requests[0].model).toBe(GROQ_REASONING_MODEL);
  });

  it("runs Groq alone when there is no key, and carries the reason for the audit package", async () => {
    const groq = scriptedLlm(searchThenBrief(GOOD_BRIEF));

    const outcome = await researchWithFallback(providers(null, groq, "GEMINI_API_KEY is not set"), stubRetriever, SIGNAL, silent);

    expect(outcome.provider).toBe("groq");
    expect(outcome.result.ok).toBe(true);
    // Not null: a reviewer reading "groq" with no reason cannot tell a
    // deliberate configuration from a quota failure.
    expect(outcome.fallbackReason).toBe("GEMINI_API_KEY is not set");
  });

  it("returns a Groq failure as a failure — there is nothing below it to fall to", async () => {
    // RESEARCH is allowed to fail: RENDER exports the video flagged
    // `ungrounded` rather than losing it.
    const gemini = scriptedLlm([{ kind: "rate_limited", message: "429", retryable: true }]);
    const groq = scriptedLlm([{ kind: "provider_error", message: "Groq is down too", retryable: true }]);

    const outcome = await researchWithFallback(providers(gemini, groq), stubRetriever, SIGNAL, silent);

    expect(outcome.provider).toBe("groq");
    expect(outcome.result.ok).toBe(false);
    expect(!outcome.result.ok && outcome.result.error.message).toContain("Groq is down too");
    // Still reports why Gemini did not answer, so a doubly-failed stage is
    // as legible as a singly-failed one.
    expect(outcome.fallbackReason).toContain("rate_limited");
  });

  it("logs the Gemini failure rather than swallowing it", async () => {
    const lines: string[] = [];
    const gemini = scriptedLlm([{ kind: "provider_error", message: "boom", retryable: true }]);
    const groq = scriptedLlm(searchThenBrief(GOOD_BRIEF));

    await researchWithFallback(providers(gemini, groq), stubRetriever, SIGNAL, (m) => lines.push(m));

    expect(lines.join("\n")).toContain(GEMINI_RESEARCH_MODEL);
    expect(lines.join("\n")).toContain("boom");
  });
});
