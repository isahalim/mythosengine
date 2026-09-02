import { describe, expect, it } from "vitest";
import { RerankingRetriever, rerankPassages } from "./rerank.ts";
import { GROQ_REASONING_MODEL } from "../../config/models.ts";
import type { RetrievedPassage, Retriever } from "./retriever.ts";
import type { DriverError, LlmDriver } from "../drivers/types.ts";
import { err, ok, type Result } from "../result.ts";

function passage(id: string, title: string, score: number): RetrievedPassage {
  return { signalId: id, title, url: `http://x/${id}`, sourceKind: "news", observedAt: "2026-09-01T00:00:00.000Z", score };
}

const candidates = [passage("a", "first", 3), passage("b", "second", 2), passage("c", "third", 1), passage("d", "fourth", 0.5)];

function answering(content: string): LlmDriver {
  return { complete: () => Promise.resolve(ok({ content, finishReason: "completed", quotaRemaining: null, tokensUsed: 1 })) };
}

const failing: LlmDriver = {
  complete: () => Promise.resolve(err({ kind: "rate_limited", message: "429", retryable: true } as DriverError)),
};

function fixedRetriever(results: RetrievedPassage[]): Retriever & { lastTopK: number } {
  const stub = {
    lastTopK: 0,
    search(_query: string, topK: number): Promise<Result<RetrievedPassage[], DriverError>> {
      stub.lastTopK = topK;
      return Promise.resolve(ok(results));
    },
    get: () => Promise.resolve(ok(null)),
  };
  return stub;
}

describe("rerankPassages", () => {
  // This stage names its own model — no caller passes one in — so a wrong
  // one here is a stage that silently stops reranking in production while
  // every other test still passes. It shipped exactly that way on
  // 2026-09-01: the string sent was "gemini-ladder", which Groq rejects.
  it("asks the reasoning model the pipeline actually runs on", async () => {
    const asked: string[] = [];
    const llm: LlmDriver = {
      complete: (req) => {
        asked.push(req.model);
        return Promise.resolve(ok({ content: JSON.stringify({ ranked_positions: [1, 2, 3, 4] }), finishReason: "completed", quotaRemaining: null, tokensUsed: 1 }));
      },
    };
    await rerankPassages(llm, "prisons", candidates, 4);
    expect(asked).toEqual([GROQ_REASONING_MODEL]);
  });

  it("reorders the candidates into the model's order", async () => {
    const llm = answering(JSON.stringify({ ranked_positions: [3, 1, 4, 2] }));
    const ranked = await rerankPassages(llm, "prisons", candidates, 4);
    expect(ranked.map((p) => p.signalId)).toEqual(["c", "a", "d", "b"]);
  });

  it("returns the same passage objects, so provenance is untouched", async () => {
    const llm = answering(JSON.stringify({ ranked_positions: [2, 1, 3, 4] }));
    const ranked = await rerankPassages(llm, "prisons", candidates, 4);
    // Reordered, never re-scored or rewritten — a reranker that edited a
    // passage could change what a citation points at.
    expect(ranked[0]).toBe(candidates[1]);
    expect(ranked[0].score).toBe(2);
  });

  it("cannot conjure a passage retrieval did not return", async () => {
    // The whole safety property: the model may only reorder, so it can never
    // introduce a citation `researchSignal` would be unable to verify. With
    // positions that is a bounds check — 99 names nothing.
    const llm = answering(JSON.stringify({ ranked_positions: [99, 1] }));
    const ranked = await rerankPassages(llm, "prisons", candidates, 4);
    expect(ranked.map((p) => p.signalId)).toEqual(["a", "b", "c", "d"]);
    expect(ranked).toHaveLength(4);
  });

  it("ignores a repeated position rather than duplicating a passage", async () => {
    const llm = answering(JSON.stringify({ ranked_positions: [1, 1, 2] }));
    const ranked = await rerankPassages(llm, "prisons", candidates, 4);
    expect(ranked.map((p) => p.signalId)).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps anything the model dropped, at the back in BM25 order", async () => {
    const llm = answering(JSON.stringify({ ranked_positions: [4] }));
    const ranked = await rerankPassages(llm, "prisons", candidates, 4);
    expect(ranked.map((p) => p.signalId)).toEqual(["d", "a", "b", "c"]);
  });

  it("keeps the BM25 order when the model call fails", async () => {
    const ranked = await rerankPassages(failing, "prisons", candidates, 4);
    expect(ranked.map((p) => p.signalId)).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps the BM25 order when the answer is not JSON", async () => {
    const ranked = await rerankPassages(answering("I think c is best"), "prisons", candidates, 4);
    expect(ranked.map((p) => p.signalId)).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps the BM25 order when the JSON is the wrong shape", async () => {
    const ranked = await rerankPassages(answering(JSON.stringify({ order: ["c"] })), "prisons", candidates, 4);
    expect(ranked.map((p) => p.signalId)).toEqual(["a", "b", "c", "d"]);
  });

  it("does not spend a request on a set too small to be worth reordering", async () => {
    let called = false;
    const llm: LlmDriver = {
      complete: () => {
        called = true;
        return Promise.resolve(ok({ content: "{}", finishReason: "completed", quotaRemaining: null, tokensUsed: 0 }));
      },
    };
    const ranked = await rerankPassages(llm, "prisons", candidates.slice(0, 2), 2);
    expect(called).toBe(false);
    expect(ranked).toHaveLength(2);
  });

  it("truncates to topK after reordering, not before", async () => {
    const llm = answering(JSON.stringify({ ranked_positions: [4, 3, 2, 1] }));
    const ranked = await rerankPassages(llm, "prisons", candidates, 2);
    expect(ranked.map((p) => p.signalId)).toEqual(["d", "c"]);
  });
});

describe("RerankingRetriever", () => {
  it("asks retrieval for more candidates than the caller wants, then narrows", async () => {
    const inner = fixedRetriever(candidates);
    const retriever = new RerankingRetriever(inner, answering(JSON.stringify({ ranked_positions: [3, 2, 1, 4] })), () => {});
    const result = await retriever.search("prisons", 2);
    expect(inner.lastTopK).toBe(6);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((p) => p.signalId)).toEqual(["c", "b"]);
  });

  it("passes a retrieval failure straight through rather than reranking nothing", async () => {
    const inner: Retriever = {
      search: () => Promise.resolve(err({ kind: "provider_error", message: "db down", retryable: true } as DriverError)),
      get: () => Promise.resolve(ok(null)),
    };
    const result = await new RerankingRetriever(inner, answering("{}"), () => {}).search("prisons", 3);
    expect(result.ok).toBe(false);
  });

  it("leaves the read-the-source lookup alone — only ranking is the model's job", async () => {
    const inner = fixedRetriever(candidates);
    const retriever = new RerankingRetriever(inner, failing, () => {});
    expect((await retriever.get("a")).ok).toBe(true);
  });
});
