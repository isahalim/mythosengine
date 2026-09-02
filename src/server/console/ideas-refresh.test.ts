import { describe, expect, it } from "vitest";
import type { DriverError, LlmDriver, LlmRequest, LlmResponse } from "../../lib/drivers/types.ts";
import { err, ok, type Result } from "../../lib/result.ts";
import { createTestDb } from "../../../db/client.ts";
import { applyMigrations } from "../../../db/apply-migrations.ts";
import { signals, sources } from "../../../db/schema.ts";
import { ingestLatest, rankIdeasReranked } from "./ideas-refresh.ts";
import { GROQ_REASONING_MODEL } from "../../config/models.ts";

function scriptedLlm(turn: Partial<LlmResponse> | DriverError): LlmDriver & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  return {
    requests,
    async complete(req): Promise<Result<LlmResponse, DriverError>> {
      requests.push(req);
      if ("kind" in turn) return err(turn);
      return ok({ content: "", finishReason: "stop", quotaRemaining: null, tokensUsed: null, ...turn } as LlmResponse);
    },
  };
}

/** Six AI-topic signals, so the reranker has something worth reordering (it declines under three). */
async function seed(db: ReturnType<typeof createTestDb>["db"]): Promise<void> {
  await db.insert(sources).values({ id: "src1", url: "https://example.com/feed", kind: "rss", enabled: 0 }).run();
  const titles = [
    "OpenAI model release draws criticism from researchers",
    "AI automation replaces algorithm teams at a major startup",
    "Anthropic publishes an llm safety study",
    "Chatgpt usage data shows an automation shift",
    "Artificial intelligence policy fight reaches the senate",
    "Robot algorithm patent dispute widens",
  ];
  await db
    .insert(signals)
    .values(
      titles.map((title, i) => ({
        id: `sig${i}`,
        sourceId: "src1",
        canonicalUrl: `https://example.com/${i}`,
        title,
        state: "scored" as const,
        engagementScore: 10 - i,
        observedAt: `2026-09-0${i + 1}T00:00:00.000Z`,
        simhash: `sim${i}`,
      })),
    )
    .run();
}

describe("ingestLatest", () => {
  it("reports a clean refresh over zero enabled sources rather than failing", async () => {
    const ctx = createTestDb();
    applyMigrations(ctx.client);

    const result = await ingestLatest(ctx.db, () => {});

    expect(result).toEqual({ sourcesFetched: 0, sourcesFailed: 0, newSignals: 0, degradedReason: null });
  });
});

describe("rankIdeasReranked", () => {
  it("returns the model's order, not BM25's", async () => {
    const ctx = createTestDb();
    applyMigrations(ctx.client);
    await seed(ctx.db);

    // Reverse whatever it was given, so a caller that ignored the order
    // would be visibly wrong rather than coincidentally right.
    const llm = scriptedLlm({ content: JSON.stringify({ ranked_positions: [6, 5, 4, 3, 2, 1] }) });
    const baseline = await rankIdeasReranked(ctx.db, "ai", 3, [], scriptedLlm({ kind: "provider_error", message: "x", retryable: false }), () => {});
    const result = await rankIdeasReranked(ctx.db, "ai", 3, [], llm, () => {});

    expect(result.rerankedBy).toBe(GROQ_REASONING_MODEL);
    expect(result.degradedReason).toBeNull();
    expect(result.ideas.map((i) => i.signalId)).not.toEqual(baseline.ideas.map((i) => i.signalId));
  });

  it("offers the model more candidates than the operator will see", async () => {
    // Reordering exactly the items BM25 already chose can only permute a
    // decision already made — the value is in what gets promoted.
    const ctx = createTestDb();
    applyMigrations(ctx.client);
    await seed(ctx.db);

    const llm = scriptedLlm({ content: JSON.stringify({ ranked_positions: [1, 2] }) });
    await rankIdeasReranked(ctx.db, "ai", 2, [], llm, () => {});

    const prompt = llm.requests[0].messages[0].content;
    expect(prompt).toContain("6.");
  });

  it("asks for the model named in config, never one inlined here", async () => {
    const ctx = createTestDb();
    applyMigrations(ctx.client);
    await seed(ctx.db);

    const llm = scriptedLlm({ content: JSON.stringify({ ranked_positions: [1] }) });
    await rankIdeasReranked(ctx.db, "ai", 3, [], llm, () => {});

    expect(llm.requests[0].model).toBe(GROQ_REASONING_MODEL);
  });

  it("keeps the BM25 order and says why when the model fails", async () => {
    const ctx = createTestDb();
    applyMigrations(ctx.client);
    await seed(ctx.db);

    const llm = scriptedLlm({ kind: "rate_limited", message: "HTTP 429", retryable: true });
    const result = await rankIdeasReranked(ctx.db, "ai", 3, [], llm, () => {});

    // Never an empty screen: a rate-limited reranker costs the ordering, not
    // the ideas.
    expect(result.ideas.length).toBeGreaterThan(0);
    expect(result.rerankedBy).toBeNull();
    expect(result.degradedReason).toContain("rate_limited");
  });

  it("cannot invent an idea the corpus does not contain", async () => {
    const ctx = createTestDb();
    applyMigrations(ctx.client);
    await seed(ctx.db);

    // Positions off the end of the list, and a repeat.
    const llm = scriptedLlm({ content: JSON.stringify({ ranked_positions: [99, 1, 1, -4] }) });
    const result = await rankIdeasReranked(ctx.db, "ai", 3, [], llm, () => {});

    const ids = result.ideas.map((i) => i.signalId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.startsWith("sig")).toBe(true);
  });

  it("honours exclude, so one run cannot make two videos about one story", async () => {
    const ctx = createTestDb();
    applyMigrations(ctx.client);
    await seed(ctx.db);

    const llm = scriptedLlm({ content: JSON.stringify({ ranked_positions: [1, 2, 3] }) });
    const result = await rankIdeasReranked(ctx.db, "ai", 3, ["sig0", "sig1"], llm, () => {});

    expect(result.ideas.map((i) => i.signalId)).not.toContain("sig0");
    expect(result.ideas.map((i) => i.signalId)).not.toContain("sig1");
  });
});
