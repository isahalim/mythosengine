import { describe, expect, it } from "vitest";
import type { DriverError, LlmDriver, LlmMessage, LlmRequest, LlmResponse } from "../drivers/types.ts";
import { err, ok, type Result } from "../result.ts";
import type { Retriever, RetrievedPassage } from "./retriever.ts";
import { fitToRequestBudget, researchSignal } from "./research.ts";
import { GROQ_REASONING_MODEL } from "../../config/models.ts";

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

/** An LLM that replays a fixed script of turns, recording what it was asked. */
function scriptedLlm(turns: (Partial<LlmResponse> | DriverError)[]): LlmDriver & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  let index = 0;
  return {
    requests,
    async complete(req): Promise<Result<LlmResponse, DriverError>> {
      requests.push(req);
      const turn = turns[Math.min(index++, turns.length - 1)];
      if ("kind" in turn) return err(turn);
      return ok({ content: "", finishReason: "stop", quotaCost: 1, ...turn } as LlmResponse);
    },
  };
}

function toolCall(name: string, args: unknown, id = "call1") {
  return { toolCalls: [{ id, name, argumentsJson: JSON.stringify(args) }] };
}

const GOOD_BRIEF = JSON.stringify({
  summary: "Rockstar delayed GTA VI to 2027 and the market reacted.",
  key_points: ["The delay is the second one", "Analysts cut their targets"],
  citations: [
    { signal_id: "sig1", claim: "Rockstar confirmed the 2027 window" },
    { signal_id: "sig2", claim: "Analysts cut Take-Two targets" },
  ],
});

describe("fitToRequestBudget", () => {
  it("drops the oldest tool results first, and never the instructions or the topic", () => {
    const messages: LlmMessage[] = [
      { role: "system", content: "instructions" },
      { role: "user", content: "topic" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_source", argumentsJson: "{}" }] },
      { role: "tool", content: "x".repeat(4000), toolCallId: "c1" },
      { role: "assistant", content: "", toolCalls: [{ id: "c2", name: "read_source", argumentsJson: "{}" }] },
      { role: "tool", content: "y".repeat(4000), toolCallId: "c2" },
    ];

    // 2000 tokens of ceiling, 500 reserved for the completion => 6000 chars,
    // which one of the two 4,000-character results has to go to fit under.
    const dropped = fitToRequestBudget(messages, 500, 2000);

    expect(dropped).toBe(1);
    expect(messages[0].content).toBe("instructions");
    expect(messages[1].content).toBe("topic");
    // Oldest tool result went; the newest — the one the model is reasoning
    // about — survived.
    expect(messages[3].content).not.toContain("xxxx");
    expect(messages[5].content).toBe("y".repeat(4000));
    // The assistant turn that asked for the dropped result keeps its tool
    // call, so the call/result pairing the wire format requires is intact.
    expect(messages[2].toolCalls).toHaveLength(1);
  });

  it("does nothing when the conversation already fits", () => {
    const messages: LlmMessage[] = [{ role: "system", content: "short" }, { role: "tool", content: "also short", toolCallId: "c1" }];
    expect(fitToRequestBudget(messages, 100, 2000)).toBe(0);
    expect(messages[1].content).toBe("also short");
  });

  it("stops once it is under budget rather than emptying the transcript", () => {
    const messages: LlmMessage[] = [
      { role: "system", content: "s" },
      { role: "tool", content: "a".repeat(3000), toolCallId: "c1" },
      { role: "tool", content: "b".repeat(1000), toolCallId: "c2" },
    ];
    fitToRequestBudget(messages, 0, 500); // 2000 chars of budget
    expect(messages[2].content).toBe("b".repeat(1000));
  });
});

describe("researchSignal", () => {
  it("keeps the request inside the per-request token ceiling Groq enforces", async () => {
    // A request larger than the whole per-minute budget is refused outright
    // with HTTP 413, not queued — "Limit 8000, Requested 8033" cost the
    // 2026-09-02 render its grounding. The limiter cannot prevent that; only
    // bounding the payload can.
    const CEILING = 7200; // QUOTAS.groq.tokensPerMinute * 0.9, the real one
    const fatArticles = { fetchArticle: async (url: string) => ok({ url, text: "z".repeat(12_000), truncated: true }) };
    const llm = scriptedLlm([
      toolCall("search_discourse", { query: "GTA VI" }, "c0"),
      toolCall("read_source", { signal_id: "sig1" }, "c1"),
      toolCall("read_source", { signal_id: "sig2" }, "c2"),
      { content: GOOD_BRIEF },
    ]);

    const result = await researchSignal(llm, stubRetriever, fatArticles, SIGNAL, { promptTemplate: PROMPT, requestTokenCeiling: CEILING });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The brief still landed, and it says it was written from less than
    // everything the model retrieved.
    expect(result.value.toolResultsDropped).toBeGreaterThan(0);
    // Every request the driver was handed fits — that is the property.
    for (const request of llm.requests) {
      const chars = request.messages.reduce((sum, m) => sum + m.content.length, 0);
      expect(chars / 4 + (request.maxTokens ?? 0)).toBeLessThanOrEqual(CEILING);
    }
  });

  it("defaults to the reasoning model the pipeline actually runs on", async () => {
    const llm = scriptedLlm([toolCall("search_discourse", { query: "GTA VI" }), { content: GOOD_BRIEF }]);
    await researchSignal(llm, stubRetriever, stubArticles, SIGNAL, { promptTemplate: PROMPT });
    expect(llm.requests.map((r) => r.model)).toEqual([GROQ_REASONING_MODEL, GROQ_REASONING_MODEL]);
  });

  it("searches, then returns a brief whose citations carry full provenance", async () => {
    const llm = scriptedLlm([toolCall("search_discourse", { query: "GTA VI delay" }), { content: GOOD_BRIEF }]);

    const result = await researchSignal(llm, stubRetriever, stubArticles, SIGNAL, { promptTemplate: PROMPT });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.summary).toContain("2027");
    expect(result.value.keyPoints).toHaveLength(2);
    expect(result.value.toolCallsMade).toEqual(["search_discourse"]);
    // The citation is what the audit package shows a reviewer, so it has to
    // carry the real title and URL, not just the id the model emitted.
    expect(result.value.citations[0]).toMatchObject({
      signalId: "sig1",
      title: "GTA VI delayed to 2027, Rockstar confirms",
      url: "https://news.example.com/1",
      sourceKind: "rss",
    });
  });

  it("drops a citation naming a signal that was never retrieved", async () => {
    const fabricated = JSON.stringify({
      summary: "s",
      key_points: ["k"],
      citations: [
        { signal_id: "sig1", claim: "real" },
        { signal_id: "totally-made-up", claim: "fabricated" },
      ],
    });
    const llm = scriptedLlm([toolCall("search_discourse", { query: "gta" }), { content: fabricated }]);

    const result = await researchSignal(llm, stubRetriever, stubArticles, SIGNAL, { promptTemplate: PROMPT });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.citations.map((c) => c.signalId)).toEqual(["sig1"]);
  });

  it("rejects a brief whose citations are all fabricated, rather than passing it off as grounded", async () => {
    const allFake = JSON.stringify({ summary: "s", key_points: ["k"], citations: [{ signal_id: "nope", claim: "c" }] });
    const llm = scriptedLlm([toolCall("search_discourse", { query: "gta" }), { content: allFake }]);

    const result = await researchSignal(llm, stubRetriever, stubArticles, SIGNAL, { promptTemplate: PROMPT });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("invalid_response");
      expect(result.error.message).toContain("no citation traceable");
    }
  });

  it("rejects a brief that never called a tool, since nothing could ground it", async () => {
    // A model answering from memory is precisely the failure this stage
    // exists to prevent: with no search, `seen` is empty and every citation
    // is by definition untraceable.
    const llm = scriptedLlm([{ content: GOOD_BRIEF }]);

    const result = await researchSignal(llm, stubRetriever, stubArticles, SIGNAL, { promptTemplate: PROMPT });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("no citation traceable");
  });

  it("refuses to read a source that no search returned in this run", async () => {
    let fetched = 0;
    const countingArticles = {
      fetchArticle: async (url: string) => {
        fetched++;
        return ok({ url, text: "x", truncated: false });
      },
    };
    const llm = scriptedLlm([toolCall("read_source", { signal_id: "sig2" }), { content: GOOD_BRIEF }]);

    await researchSignal(llm, stubRetriever, countingArticles, SIGNAL, { promptTemplate: PROMPT });

    // sig2 exists in the corpus, but it was never retrieved in this run —
    // resolving it anyway would let a guessed id become an outbound fetch.
    expect(fetched).toBe(0);
    const toolReply = llm.requests[1].messages.find((m) => m.role === "tool");
    expect(toolReply?.content).toContain("unknown_signal_id");
  });

  it("reads a source once search has surfaced it", async () => {
    const llm = scriptedLlm([
      toolCall("search_discourse", { query: "gta" }, "c1"),
      toolCall("read_source", { signal_id: "sig2" }, "c2"),
      { content: GOOD_BRIEF },
    ]);

    const result = await researchSignal(llm, stubRetriever, stubArticles, SIGNAL, { promptTemplate: PROMPT });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.toolCallsMade).toEqual(["search_discourse", "read_source"]);
    const toolReplies = llm.requests[2].messages.filter((m) => m.role === "tool");
    expect(toolReplies[1].content).toContain("The delay was announced on a Tuesday.");
  });

  it("hands a failed fetch back to the model as a typed tool error instead of aborting", async () => {
    const failingArticles = {
      fetchArticle: async (): Promise<Result<{ url: string; text: string; truncated: boolean }, DriverError>> =>
        err({ kind: "timeout", message: "took too long", retryable: true }),
    };
    const llm = scriptedLlm([
      toolCall("search_discourse", { query: "gta" }, "c1"),
      toolCall("read_source", { signal_id: "sig1" }, "c2"),
      { content: GOOD_BRIEF },
    ]);

    const result = await researchSignal(llm, stubRetriever, failingArticles, SIGNAL, { promptTemplate: PROMPT });

    // One unreachable page is not a reason to lose the brief built from the
    // headlines that did come back.
    expect(result.ok).toBe(true);
    const toolReplies = llm.requests[2].messages.filter((m) => m.role === "tool");
    expect(toolReplies[1].content).toContain("timeout");
  });

  it("hands a retrieval failure back as a tool error too", async () => {
    const failingRetriever: Retriever = {
      search: async () => err({ kind: "provider_error", message: "index unavailable", retryable: true }),
      get: async () => ok(null),
    };
    const llm = scriptedLlm([toolCall("search_discourse", { query: "gta" }), { content: GOOD_BRIEF }]);

    const result = await researchSignal(llm, failingRetriever, stubArticles, SIGNAL, { promptTemplate: PROMPT });

    // Nothing was retrieved, so nothing is citable, so the brief is refused.
    expect(result.ok).toBe(false);
    const toolReply = llm.requests[1].messages.find((m) => m.role === "tool");
    expect(toolReply?.content).toContain("index unavailable");
  });

  it("returns the driver's error when the model itself is unreachable", async () => {
    const llm = scriptedLlm([{ kind: "rate_limited", message: "TPM exceeded", retryable: true }]);

    const result = await researchSignal(llm, stubRetriever, stubArticles, SIGNAL, { promptTemplate: PROMPT });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("rate_limited");
      expect(result.error.retryable).toBe(true);
    }
  });

  it("rejects malformed JSON rather than guessing at the brief", async () => {
    const llm = scriptedLlm([toolCall("search_discourse", { query: "gta" }), { content: "here you go: {not json" }]);

    const result = await researchSignal(llm, stubRetriever, stubArticles, SIGNAL, { promptTemplate: PROMPT });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("did not return JSON");
  });

  it("accepts a brief the model wrapped in a markdown fence", async () => {
    const llm = scriptedLlm([toolCall("search_discourse", { query: "gta" }), { content: "```json\n" + GOOD_BRIEF + "\n```" }]);

    const result = await researchSignal(llm, stubRetriever, stubArticles, SIGNAL, { promptTemplate: PROMPT });
    expect(result.ok).toBe(true);
  });

  it("rejects JSON that parses but isn't a brief", async () => {
    const llm = scriptedLlm([toolCall("search_discourse", { query: "gta" }), { content: JSON.stringify({ summary: "s" }) }]);

    const result = await researchSignal(llm, stubRetriever, stubArticles, SIGNAL, { promptTemplate: PROMPT });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("failed schema validation");
  });

  it("asks for the brief on the final turn, but still offers the tools", async () => {
    // Withholding `tools` to force an answer is what 400'd live on
    // 2026-08-31: Groq validates the generation against the request and
    // rejects "model called a tool" when none were on offer. So the tools
    // stay, and the instruction is what makes a call unwanted.
    const llm = scriptedLlm([
      toolCall("search_discourse", { query: "a" }, "c1"),
      toolCall("search_discourse", { query: "b" }, "c2"),
      { content: GOOD_BRIEF },
    ]);

    const result = await researchSignal(llm, stubRetriever, stubArticles, SIGNAL, { promptTemplate: PROMPT, maxIterations: 3 });

    expect(result.ok).toBe(true);
    expect(llm.requests[2].tools).toBeDefined();
    const lastUserTurn = llm.requests[2].messages.filter((m) => m.role === "user").at(-1);
    expect(lastUserTurn?.content).toContain("last research turn");
  });

  it("fails typed — never throws — when the model calls tools through every turn", async () => {
    // The degraded path RENDER relies on: a research stage that never settles
    // costs the render its grounding, not the render itself.
    const llm = scriptedLlm([toolCall("search_discourse", { query: "again" })]);

    const result = await researchSignal(llm, stubRetriever, stubArticles, SIGNAL, { promptTemplate: PROMPT, maxIterations: 2 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("invalid_response");
      expect(result.error.message).toContain("without producing a brief");
    }
  });

  it("survives a tool call with unparseable arguments", async () => {
    const llm = scriptedLlm([
      { toolCalls: [{ id: "c1", name: "search_discourse", argumentsJson: "{{{" }] },
      toolCall("search_discourse", { query: "gta" }, "c2"),
      { content: GOOD_BRIEF },
    ]);

    const result = await researchSignal(llm, stubRetriever, stubArticles, SIGNAL, { promptTemplate: PROMPT });

    expect(result.ok).toBe(true);
    const firstReply = llm.requests[1].messages.find((m) => m.role === "tool");
    expect(firstReply?.content).toContain("invalid_arguments");
  });

  it("reports a tool the model invented", async () => {
    const llm = scriptedLlm([toolCall("browse_the_web", { url: "https://anywhere" }), { content: GOOD_BRIEF }]);

    await researchSignal(llm, stubRetriever, stubArticles, SIGNAL, { promptTemplate: PROMPT });

    const reply = llm.requests[1].messages.find((m) => m.role === "tool");
    expect(reply?.content).toContain("unknown_tool");
  });

  it("puts the signal's title into the system prompt and the opening message", async () => {
    const llm = scriptedLlm([{ content: "not json" }]);
    await researchSignal(llm, stubRetriever, stubArticles, SIGNAL, { promptTemplate: PROMPT });

    expect(llm.requests[0].messages[0].content).toContain("GTA VI delayed to 2027");
    expect(llm.requests[0].messages[1].content).toContain("GTA VI delayed to 2027");
  });
});
