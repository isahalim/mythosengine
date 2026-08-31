import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../../../db/apply-migrations.ts";
import { createTestDb } from "../../../db/client.ts";
import { scripts, signals, sources } from "../../../db/schema.ts";
import { ok, type Result } from "../result.ts";
import type { DriverError, LlmDriver, LlmRequest, LlmResponse } from "../drivers/types.ts";
import { formatResearchBrief, generateDiscourseScript, generateScript } from "./script.ts";

const PROMPT_TEMPLATE = "Signal: {{signal_title_and_summary}}. Research: {{research_brief}} Output JSON only.";

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
    const result = await generateScript(ctx.client, { id: "sig1", title }, llm, null, () => Date.parse("2026-08-28T01:00:00Z"), PROMPT_TEMPLATE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.hook.length).toBeGreaterThan(0);
      expect(result.value.body.length).toBeGreaterThan(0);
      expect(result.value.debateQuestion.length).toBeGreaterThan(0);
    }
  });

  it("inserts a draft script row and transitions the signal to scripted", async () => {
    const llm = new ScriptedLlm([llmResponse(VALID_SCRIPT_JSON)]);
    const result = await generateScript(ctx.client, { id: "sig1", title: "Big balance patch splits the community" }, llm, null, () => Date.parse("2026-08-28T01:00:00Z"), PROMPT_TEMPLATE);
    expect(result.ok).toBe(true);

    if (!result.ok) throw new Error("expected an ok result");
    const row = ctx.db.select().from(scripts).where(eq(scripts.id, result.value.id)).get();
    expect(row?.status).toBe("draft");
    expect(row?.signalId).toBe("sig1");

    const signal = ctx.db.select().from(signals).get();
    expect(signal?.state).toBe("scripted");
  });

  it("passes only the signal's title and the research brief — no other context (hallucination-boundary discipline)", async () => {
    const llm = new ScriptedLlm([llmResponse(VALID_SCRIPT_JSON)]);
    await generateScript(ctx.client, { id: "sig1", title: "Big balance patch splits the community" }, llm, null, () => Date.parse("2026-08-28T01:00:00Z"), PROMPT_TEMPLATE);
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].messages[0].content).toBe(
      "Signal: Big balance patch splits the community. Research: No research was available for this topic. Write from the signal alone (rule 5). Output JSON only.",
    );
  });

  it("puts the research brief's substance into the prompt when there is one", async () => {
    const llm = new ScriptedLlm([llmResponse(VALID_SCRIPT_JSON)]);
    await generateScript(
      ctx.client,
      { id: "sig1", title: "Big balance patch splits the community" },
      llm,
      {
        summary: "The patch halved a weapon's damage.",
        keyPoints: ["Pro players called it overdue", "Casual players called it a nerf too far"],
        citations: [{ signalId: "sig9", claim: "Pros called it overdue", title: "Pros react", url: "https://x/1", sourceKind: "reddit" }],
        toolCallsMade: ["search_discourse"],
        model: "openai/gpt-oss-20b",
      },
      () => Date.parse("2026-08-28T01:00:00Z"),
      PROMPT_TEMPLATE,
    );

    const prompt = llm.calls[0].messages[0].content;
    expect(prompt).toContain("The patch halved a weapon's damage.");
    expect(prompt).toContain("Pro players called it overdue");
    // The claim and its source travel together — the writer is told what
    // each fact rests on, not just handed a pile of assertions.
    expect(prompt).toContain("[reddit: Pros react]");
  });

  it("repairs once on invalid JSON, then succeeds", async () => {
    const llm = new ScriptedLlm([llmResponse("not json at all"), llmResponse(VALID_SCRIPT_JSON)]);
    const result = await generateScript(ctx.client, { id: "sig1", title: "Big balance patch splits the community" }, llm, null, () => Date.parse("2026-08-28T01:00:00Z"), PROMPT_TEMPLATE);
    expect(result.ok).toBe(true);
    expect(llm.calls).toHaveLength(2);
  });

  it("hard-fails after the JSON is invalid twice in a row", async () => {
    const llm = new ScriptedLlm([llmResponse("not json"), llmResponse("still not json")]);
    const result = await generateScript(ctx.client, { id: "sig1", title: "Big balance patch splits the community" }, llm, null, () => Date.parse("2026-08-28T01:00:00Z"), PROMPT_TEMPLATE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid_response");
  });

  it("hard-fails when the response is valid JSON but fails schema validation twice", async () => {
    const llm = new ScriptedLlm([llmResponse(JSON.stringify({ hook: "only a hook" })), llmResponse(JSON.stringify({ hook: "still only a hook" }))]);
    const result = await generateScript(ctx.client, { id: "sig1", title: "Big balance patch splits the community" }, llm, null, () => Date.parse("2026-08-28T01:00:00Z"), PROMPT_TEMPLATE);
    expect(result.ok).toBe(false);
  });

  it("asks for enough completion budget to cover the model's reasoning as well as the script", async () => {
    // SCRIPT failed live on 2026-08-31 with Groq's own words: "max completion
    // tokens reached before generating a valid document". The script itself
    // is ~250 tokens; the gpt-oss reasoning ahead of it is what overran 1024.
    const llm = new ScriptedLlm([llmResponse(VALID_SCRIPT_JSON)]);
    await generateScript(ctx.client, { id: "sig1", title: "Big balance patch splits the community" }, llm, null, () => Date.parse("2026-08-28T01:00:00Z"), PROMPT_TEMPLATE);

    expect(llm.calls[0].maxTokens).toBeGreaterThanOrEqual(3072);
    // ...and not so large that one call can drain the 8k/min token bucket,
    // which is how the old browser agent used to hang the job outright.
    expect(llm.calls[0].maxTokens).toBeLessThan(6000);
  });

  it("repairs once when Groq rejects its own model's malformed JSON, instead of hard-failing", async () => {
    // Groq validates JSON-mode output server-side and returns HTTP 400
    // `json_validate_failed`. That is the model failing to produce valid
    // JSON — what the repair loop is for — but it arrives as a provider
    // error, and used to bypass it. SCRIPT died on exactly this live on
    // 2026-08-31.
    const llm = new ScriptedLlm([
      { ok: false, error: { kind: "provider_error", message: `HTTP 400 from https://api.groq.com/...: {"error":{"code":"json_validate_failed"}}`, retryable: false } },
      llmResponse(VALID_SCRIPT_JSON),
    ]);
    const result = await generateScript(ctx.client, { id: "sig1", title: "Big balance patch splits the community" }, llm, null, () => Date.parse("2026-08-28T01:00:00Z"), PROMPT_TEMPLATE);

    expect(result.ok).toBe(true);
    expect(llm.calls).toHaveLength(2);
  });

  it("gives up after a second json_validate_failed rather than looping", async () => {
    const rejection = { ok: false as const, error: { kind: "provider_error" as const, message: `HTTP 400: {"error":{"code":"json_validate_failed"}}`, retryable: false } };
    const llm = new ScriptedLlm([rejection, rejection]);
    const result = await generateScript(ctx.client, { id: "sig1", title: "Big balance patch splits the community" }, llm, null, () => Date.parse("2026-08-28T01:00:00Z"), PROMPT_TEMPLATE);

    expect(result.ok).toBe(false);
    expect(llm.calls).toHaveLength(2);
    expect(ctx.db.select().from(scripts).all()).toHaveLength(0);
  });

  it("does not retry a provider error that isn't the model's JSON failing", async () => {
    // A rate limit or an outage is not something re-prompting can fix.
    const llm = new ScriptedLlm([{ ok: false, error: { kind: "rate_limited", message: "HTTP 429", retryable: true } }]);
    const result = await generateScript(ctx.client, { id: "sig1", title: "Big balance patch splits the community" }, llm, null, () => Date.parse("2026-08-28T01:00:00Z"), PROMPT_TEMPLATE);

    expect(result.ok).toBe(false);
    expect(llm.calls).toHaveLength(1);
  });

  it("does not mutate the signal or insert a script when the LLM call itself fails", async () => {
    const llm = new ScriptedLlm([{ ok: false, error: { kind: "timeout", message: "boom", retryable: true } }]);
    const result = await generateScript(ctx.client, { id: "sig1", title: "Big balance patch splits the community" }, llm, null, () => Date.parse("2026-08-28T01:00:00Z"), PROMPT_TEMPLATE);
    expect(result.ok).toBe(false);
    expect(ctx.db.select().from(scripts).all()).toHaveLength(0);
    expect(ctx.db.select().from(signals).get()?.state).toBe("scored");
  });
});

describe("formatResearchBrief", () => {
  it("says so explicitly when there is no brief, rather than rendering an empty block", () => {
    // A blank research section reads to a model like an oversight to fill in
    // from memory — which is the exact failure RESEARCH exists to prevent.
    const rendered = formatResearchBrief(null);
    expect(rendered).toContain("No research was available");
    expect(rendered.trim().length).toBeGreaterThan(0);
  });

  it("renders summary, key points and each citation's supporting source", () => {
    const rendered = formatResearchBrief({
      summary: "Summary line.",
      keyPoints: ["First point", "Second point"],
      citations: [
        { signalId: "a", claim: "Claim one", title: "Title one", url: "https://x/1", sourceKind: "rss" },
        { signalId: "b", claim: "Claim two", title: "Title two", url: "https://x/2", sourceKind: "reddit" },
      ],
      toolCallsMade: ["search_discourse"],
      model: "openai/gpt-oss-20b",
    });

    expect(rendered).toContain("Summary line.");
    expect(rendered).toContain("- First point");
    expect(rendered).toContain("- Claim one [rss: Title one]");
    expect(rendered).toContain("- Claim two [reddit: Title two]");
    // URLs are omitted on purpose: the writer cannot visit them, and they
    // are pure token cost in a prompt. They live in the audit package.
    expect(rendered).not.toContain("https://");
  });
});

describe("generateDiscourseScript", () => {
  const DISCOURSE_PROMPT = "Signal: {{signal_title_and_summary}}. Research: {{research_brief}} Target: {{target_duration_s}}s. JSON only.";

  /** ~165 words, so `estimatedReadSeconds` puts it at ~60s — the duration every test below asks for. */
  function discourseJson(moves: readonly string[], wordsPerBeat = 38): string {
    return JSON.stringify({
      hook: "Nobody reads the patch notes.",
      beats: moves.map((move, i) => ({ move, text: `${move} beat ${i} ${Array.from({ length: wordsPerBeat - 3 }, (_, w) => `w${w}`).join(" ")}` })),
      open_question: "So who was it actually for?",
    });
  }

  const VALID_DISCOURSE = discourseJson(["question", "attempt", "pushback", "land"]);
  const LECTURE = discourseJson(["question", "attempt", "land", "land"]);

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

  function generate(llm: LlmDriver, targetDurationS = 60) {
    return generateDiscourseScript(ctx.client, { id: "sig1", title: "Big balance patch splits the community" }, llm, targetDurationS, null, () => Date.parse("2026-08-28T01:00:00Z"), DISCOURSE_PROMPT);
  }

  it("stores the beats and the target duration alongside the v1 columns", async () => {
    const result = await generate(new ScriptedLlm([llmResponse(VALID_DISCOURSE)]));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected an ok result");

    const row = ctx.db.select().from(scripts).where(eq(scripts.id, result.value.id)).get();
    expect(row?.targetDurationS).toBe(60);
    expect(JSON.parse(row?.beats ?? "null")).toEqual([
      { move: "question", text: expect.stringContaining("question beat 0") },
      { move: "attempt", text: expect.stringContaining("attempt beat 1") },
      { move: "pushback", text: expect.stringContaining("pushback beat 2") },
      { move: "land", text: expect.stringContaining("land beat 3") },
    ]);
  });

  it("writes the spoken narration into `body`, so every v1 consumer keeps working", async () => {
    const result = await generate(new ScriptedLlm([llmResponse(VALID_DISCOURSE)]));
    if (!result.ok) throw new Error("expected an ok result");

    const row = ctx.db.select().from(scripts).where(eq(scripts.id, result.value.id)).get();
    // Hook first, every beat in order, closing question last — the exact
    // string TTS is handed.
    expect(row?.body).toMatch(/^Nobody reads the patch notes\. question beat 0 /);
    expect(row?.body).toMatch(/So who was it actually for\?$/);
    expect(row?.wordCount).toBe(row?.body.split(/\s+/).length);
  });

  it("transitions the signal to scripted", async () => {
    await generate(new ScriptedLlm([llmResponse(VALID_DISCOURSE)]));
    expect(ctx.db.select().from(signals).get()?.state).toBe("scripted");
  });

  it("sends a lecture back once with the specific violation, then accepts the rewrite", async () => {
    const llm = new ScriptedLlm([llmResponse(LECTURE), llmResponse(VALID_DISCOURSE)]);
    const result = await generate(llm);
    expect(result.ok).toBe(true);
    expect(llm.calls).toHaveLength(2);

    const retryPrompt = llm.calls[1].messages[0].content;
    expect(retryPrompt).toContain("previous_attempt_rejected");
    expect(retryPrompt).toContain("makes this a lecture rather than a discourse");
  });

  it("fails the stage when the model writes a lecture twice — never silently ships one", async () => {
    const llm = new ScriptedLlm([llmResponse(LECTURE), llmResponse(LECTURE)]);
    const result = await generate(llm);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failure");
    expect(result.error.kind).toBe("invalid_response");
    expect(result.error.message).toContain("structure gate");
    expect(result.error.retryable).toBe(false);

    // Nothing half-written: no script row, and the signal never left `scored`.
    expect(ctx.db.select().from(scripts).all()).toHaveLength(0);
    expect(ctx.db.select().from(signals).get()?.state).toBe("scored");
  });

  it("puts the requested duration in the prompt, because the model writes to it", async () => {
    const llm = new ScriptedLlm([llmResponse(discourseJson(["question", "attempt", "pushback", "land"], 114))]);
    await generate(llm, 180);
    expect(llm.calls[0].messages[0].content).toContain("Target: 180s.");
  });

  it("holds the same hallucination boundary as v1 — the title and the brief, nothing else", async () => {
    const llm = new ScriptedLlm([llmResponse(VALID_DISCOURSE)]);
    await generate(llm);
    expect(llm.calls[0].messages[0].content).toBe(
      "Signal: Big balance patch splits the community. Research: No research was available for this topic. Write from the signal alone (rule 5). Target: 60s. JSON only.",
    );
  });
});
