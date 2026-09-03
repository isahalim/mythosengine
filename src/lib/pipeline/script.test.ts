import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../../../db/apply-migrations.ts";
import { createTestDb } from "../../../db/client.ts";
import { scripts, signals, sources } from "../../../db/schema.ts";
import { ok, type Result } from "../result.ts";
import type { DriverError, LlmDriver, LlmRequest, LlmResponse } from "../drivers/types.ts";
import { formatResearchBrief, generateDiscourseScript } from "./script.ts";
import { GROQ_REASONING_MODEL } from "../../config/models.ts";

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
      toolResultsDropped: 0, toolCallsMade: ["search_discourse"],
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

  it("defaults to the reasoning model the pipeline actually runs on", async () => {
    const llm = new ScriptedLlm([llmResponse(VALID_DISCOURSE)]);
    await generate(llm);
    expect(llm.calls.map((c) => c.model)).toEqual([GROQ_REASONING_MODEL]);
  });

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

  it("ships a lecture, because the format is no longer something a script can fail", async () => {
    // Until 2026-09-03 this exact draft — attempt straight to land, never
    // wrong once — cost the render. The gate could only describe a
    // discourse, so it made every script one; operator direction removed it.
    const llm = new ScriptedLlm([llmResponse(LECTURE)]);
    const result = await generate(llm);

    expect(result.ok).toBe(true);
    expect(llm.calls).toHaveLength(1);
    if (!result.ok) throw new Error("expected an ok result");
    expect(result.value.structureNotes).toEqual([]);
    expect(ctx.db.select().from(signals).get()?.state).toBe("scripted");
  });

  it("accepts every format the old gate would have refused", async () => {
    for (const moves of [
      ["setup", "escalation", "turn", "land"],
      ["verdict", "evidence", "escalation", "punchline"],
      ["confession", "setup", "reframe", "open"],
    ] as const) {
      const result = await generate(new ScriptedLlm([llmResponse(discourseJson([...moves]))]));
      expect(result.ok).toBe(true);
    }
    expect(ctx.db.select().from(scripts).all()).toHaveLength(3);
  });

  it("ships a script whose only fault is its length, instead of losing the render to an estimate", async () => {
    // The 2026-09-03 failure, exactly: a complete, well-formed discourse
    // script rejected for `118s is over the 113s ceiling for a 90s video`.
    // A 4% miss on a 165-wpm guess is not worth a day's video — AUDIT
    // SUMMARY flags the word count on the review surface instead.
    const overlong = discourseJson(["question", "attempt", "pushback", "land"], 60);
    const llm = new ScriptedLlm([llmResponse(overlong), llmResponse(overlong)]);
    const result = await generate(llm, 60);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected an ok result");
    expect(result.value.structureNotes).toHaveLength(1);
    expect(result.value.structureNotes[0]).toContain("over the");

    // And it is a real, complete row — not a half-written one.
    expect(ctx.db.select().from(scripts).all()).toHaveLength(1);
    expect(ctx.db.select().from(signals).get()?.state).toBe("scripted");
  });

  it("reports nothing when the draft is clean", async () => {
    const result = await generate(new ScriptedLlm([llmResponse(VALID_DISCOURSE)]));
    if (!result.ok) throw new Error("expected an ok result");
    expect(result.value.structureNotes).toEqual([]);
  });

  it("still spends a rewrite on a length miss before accepting it", async () => {
    // A guide, not a gate — but a guide the model gets one chance to follow,
    // and the rewrite quotes the miss and the number to aim at.
    const llm = new ScriptedLlm([llmResponse(discourseJson(["question", "attempt", "pushback", "land"], 60)), llmResponse(VALID_DISCOURSE)]);
    const result = await generate(llm, 60);

    expect(result.ok).toBe(true);
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1].messages[0].content).toContain("previous_draft_was_the_wrong_length");
    expect(llm.calls[1].messages[0].content).toContain("aim for about");
    if (!result.ok) throw new Error("expected an ok result");
    expect(result.value.structureNotes).toEqual([]);
  });

  it("spends no rewrite at all when the first draft is the right length", async () => {
    const llm = new ScriptedLlm([llmResponse(VALID_DISCOURSE)]);
    await generate(llm, 60);
    expect(llm.calls).toHaveLength(1);
  });

  it("keeps the draft closest to the target when a rewrite overshoots the other way", async () => {
    // The live run's actual shape: attempt one under the floor, attempt two
    // over the ceiling. The old loop scored only the last draft, so the
    // better of the two was thrown away unlooked-at.
    const tooShort = discourseJson(["question", "attempt", "pushback", "land"], 5);
    const wayTooLong = discourseJson(["question", "attempt", "pushback", "land"], 300);
    const result = await generate(new ScriptedLlm([llmResponse(tooShort), llmResponse(wayTooLong)]), 60);

    if (!result.ok) throw new Error("expected an ok result");
    expect(result.value.structureNotes[0]).toContain("under the");
    expect(result.value.wordCount).toBeLessThan(100);
  });

  it("stores and returns stripped text everywhere but the Gemini narration input", async () => {
    // The hook becomes the YouTube title (upload-metadata.ts) and the
    // console's headline. A delivery tag reaching either is the same class
    // of leak as one reaching the captions.
    const tagged = JSON.stringify({
      hook: "[excitedly] Nobody reads the patch notes.",
      beats: [
        { move: "attempt", text: "[giggles] Not one person." },
        { move: "land", text: "[sighs] And that is the story." },
      ],
      open_question: "[wistful] So who was it for?",
    });
    const result = await generate(new ScriptedLlm([llmResponse(tagged), llmResponse(tagged)]), 60);
    if (!result.ok) throw new Error("expected an ok result");

    expect(result.value.hook).toBe("Nobody reads the patch notes.");
    expect(result.value.debateQuestion).toBe("So who was it for?");
    expect(result.value.beats.map((b) => b.text)).toEqual(["Not one person.", "And that is the story."]);
    expect(result.value.body).not.toMatch(/[[\]]/);

    // ...and the one field that keeps them, because Gemini performs them.
    expect(result.value.narration.hook).toContain("[excitedly]");
    expect(result.value.narration.beats[0].text).toContain("[giggles]");
    expect(result.value.narration.openQuestion).toContain("[wistful]");

    const row = ctx.db.select().from(scripts).where(eq(scripts.id, result.value.id)).get();
    expect(row?.hook).toBe("Nobody reads the patch notes.");
    expect(row?.debateQuestion).toBe("So who was it for?");
    expect(row?.body).not.toMatch(/[[\]]/);
    // The beats column keeps the tags: it is the record of the performance
    // that was asked for, and the audit package reads it.
    expect(row?.beats).toContain("[giggles]");
  });

  it("reports a bracketed note that was not usable direction, rather than dropping it silently", async () => {
    const tagged = JSON.stringify({
      hook: "Hook.",
      beats: [
        { move: "attempt", text: "[she gestures at the whole idea of it, wearily and at length] Fine." },
        { move: "land", text: "[giggles] Truly fine." },
      ],
      open_question: "And?",
    });
    const result = await generate(new ScriptedLlm([llmResponse(tagged), llmResponse(tagged)]), 60);
    if (!result.ok) throw new Error("expected an ok result");
    expect(result.value.structureNotes.some((n) => n.includes("not usable direction"))).toBe(true);
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
