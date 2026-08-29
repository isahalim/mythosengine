import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../../../db/apply-migrations.ts";
import { createTestDb } from "../../../db/client.ts";
import { scripts, signals, sources } from "../../../db/schema.ts";
import { ok, type Result } from "../result.ts";
import type { DriverError, LlmDriver, LlmRequest, LlmResponse } from "../drivers/types.ts";
import { generateScript } from "./script.ts";

const PROMPT_TEMPLATE = "Signal: {{signal_title_and_summary}}. Output JSON only.";

class ScriptedLlm implements LlmDriver {
  private call = 0;
  calls: LlmRequest[] = [];
  constructor(private readonly responses: (Result<LlmResponse, DriverError>)[]) {}
  async complete(req: LlmRequest): Promise<Result<LlmResponse, DriverError>> {
    this.calls.push(req);
    const response = this.responses[this.call];
    this.call++;
    return response;
  }
}

function llmResponse(content: string): Result<LlmResponse, DriverError> {
  return ok({ content, finishReason: "stop", quotaRemaining: null, tokensUsed: null });
}

const VALID_SCRIPT_JSON = JSON.stringify({
  hook: "Nobody expected this update to break the meta overnight.",
  body: "The patch quietly nerfed the strongest build in the game, and top players are already switching. Casual players had no idea it was coming. The community is split between calling it a fix and calling it a betrayal.",
  debate_question: "Was this the right call, or did the devs just kill the fun?",
});

describe("generateScript", () => {
  let ctx: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    ctx = createTestDb();
    applyMigrations(ctx.client);
    ctx.db.insert(sources).values({ id: "src1", kind: "rss", url: "https://example.com" }).run();
    ctx.db
      .insert(signals)
      .values({ id: "sig1", sourceId: "src1", canonicalUrl: "https://example.com/1", title: "Big balance patch splits the community", observedAt: "2026-08-28T00:00:00Z", engagementScore: 1, simhash: "abc", state: "scored" })
      .run();
  });

  const SIGNAL_FIXTURES = [
    "Big balance patch splits the community",
    "Streamer's meltdown over a missed jump goes viral",
    "New DLC price sparks backlash across social media",
    "Speedrunner discovers game-breaking exploit live on stream",
    "Studio apologizes after leaked internal memo about crunch",
  ];

  it.each(SIGNAL_FIXTURES)("produces a schema-valid script for fixture signal %#", async (title) => {
    const llm = new ScriptedLlm([llmResponse(VALID_SCRIPT_JSON)]);
    const result = await generateScript(ctx.client, { id: "sig1", title }, llm, () => Date.parse("2026-08-28T01:00:00Z"), PROMPT_TEMPLATE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.hook.length).toBeGreaterThan(0);
      expect(result.value.body.length).toBeGreaterThan(0);
      expect(result.value.debateQuestion.length).toBeGreaterThan(0);
    }
  });

  it("inserts a draft script row and transitions the signal to scripted", async () => {
    const llm = new ScriptedLlm([llmResponse(VALID_SCRIPT_JSON)]);
    const result = await generateScript(ctx.client, { id: "sig1", title: "Big balance patch splits the community" }, llm, () => Date.parse("2026-08-28T01:00:00Z"), PROMPT_TEMPLATE);
    expect(result.ok).toBe(true);

    if (!result.ok) throw new Error("expected an ok result");
    const row = ctx.db.select().from(scripts).where(eq(scripts.id, result.value.id)).get();
    expect(row?.status).toBe("draft");
    expect(row?.signalId).toBe("sig1");

    const signal = ctx.db.select().from(signals).get();
    expect(signal?.state).toBe("scripted");
  });

  it("passes only the signal's title to the model — no other context (hallucination-boundary discipline)", async () => {
    const llm = new ScriptedLlm([llmResponse(VALID_SCRIPT_JSON)]);
    await generateScript(ctx.client, { id: "sig1", title: "Big balance patch splits the community" }, llm, () => Date.parse("2026-08-28T01:00:00Z"), PROMPT_TEMPLATE);
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].messages[0].content).toBe("Signal: Big balance patch splits the community. Output JSON only.");
  });

  it("repairs once on invalid JSON, then succeeds", async () => {
    const llm = new ScriptedLlm([llmResponse("not json at all"), llmResponse(VALID_SCRIPT_JSON)]);
    const result = await generateScript(ctx.client, { id: "sig1", title: "Big balance patch splits the community" }, llm, () => Date.parse("2026-08-28T01:00:00Z"), PROMPT_TEMPLATE);
    expect(result.ok).toBe(true);
    expect(llm.calls).toHaveLength(2);
  });

  it("hard-fails after the JSON is invalid twice in a row", async () => {
    const llm = new ScriptedLlm([llmResponse("not json"), llmResponse("still not json")]);
    const result = await generateScript(ctx.client, { id: "sig1", title: "Big balance patch splits the community" }, llm, () => Date.parse("2026-08-28T01:00:00Z"), PROMPT_TEMPLATE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid_response");
  });

  it("hard-fails when the response is valid JSON but fails schema validation twice", async () => {
    const llm = new ScriptedLlm([llmResponse(JSON.stringify({ hook: "only a hook" })), llmResponse(JSON.stringify({ hook: "still only a hook" }))]);
    const result = await generateScript(ctx.client, { id: "sig1", title: "Big balance patch splits the community" }, llm, () => Date.parse("2026-08-28T01:00:00Z"), PROMPT_TEMPLATE);
    expect(result.ok).toBe(false);
  });

  it("does not mutate the signal or insert a script when the LLM call itself fails", async () => {
    const llm = new ScriptedLlm([{ ok: false, error: { kind: "timeout", message: "boom", retryable: true } }]);
    const result = await generateScript(ctx.client, { id: "sig1", title: "Big balance patch splits the community" }, llm, () => Date.parse("2026-08-28T01:00:00Z"), PROMPT_TEMPLATE);
    expect(result.ok).toBe(false);
    expect(ctx.db.select().from(scripts).all()).toHaveLength(0);
    expect(ctx.db.select().from(signals).get()?.state).toBe("scored");
  });
});
