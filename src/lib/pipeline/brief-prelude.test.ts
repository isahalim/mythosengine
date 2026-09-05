import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../../../db/client.ts";
import { applyMigrations } from "../../../db/apply-migrations.ts";
import { signals, sources } from "../../../db/schema.ts";
import { claimNextRunPick, listQueuedPicks } from "../../../db/run-picks.ts";
import { err, ok, type Result } from "../result.ts";
import type { DriverError, LlmDriver, LlmRequest, LlmResponse } from "../drivers/types.ts";
import type { ResearchBrief } from "../rag/research.ts";
import { prepareBrief, type BriefPreludeDeps } from "./brief-prelude.ts";

/**
 * The chat route's glue, against a real database.
 *
 * This file exists because of a specific near-miss: the first version of
 * `chat-render.ts` imported `renderOneVideo` from `render.ts`, whose `main()`
 * ran at module scope — so a chat run would have started a second, unrelated
 * brainstorm render beside it, claiming a queued pick from an earlier session
 * and spending the day's token budget. It was caught by hand, which is not a
 * process. The branch logic moved here so it could be caught by a test.
 */

const GROUNDED: ResearchBrief = {
  summary: "Two sides, one paper.",
  keyPoints: ["the paper says less than either side claims"],
  citations: [{ signalId: null, claim: "the letter had 400 signatories", title: "A story", url: "https://example.com/a", sourceKind: "web" }],
  toolCallsMade: ["google_search:https://example.com/a"],
  toolResultsDropped: 0,
  model: "gemini-3.8-flash",
};

function fakeLlm(answer: string | DriverError): LlmDriver {
  return {
    complete(_req: LlmRequest): Promise<Result<LlmResponse, DriverError>> {
      if (typeof answer !== "string") return Promise.resolve(err(answer));
      return Promise.resolve(ok({ content: answer, finishReason: "stop", quotaRemaining: null, tokensUsed: null }));
    },
  };
}

const SPECIFIC = JSON.stringify({
  specificity: "specific",
  topic: "ai",
  title: "Why every AI safety debate collapses into the same two people",
  angle: "It is about who is in the room, not about risk.",
  must_include: [],
  voice: "Puck",
  language: "Spanish",
});

const LONG_PROMPT = "Why every AI safety debate collapses into the same two people arguing about the same paper";

describe("prepareBrief", () => {
  let ctx: ReturnType<typeof createTestDb>;
  let research: BriefPreludeDeps["research"];

  function deps(overrides: Partial<BriefPreludeDeps> = {}): BriefPreludeDeps {
    return { db: ctx.db, rawClient: ctx.client, digestLlm: fakeLlm(SPECIFIC), research, log: () => undefined, ...overrides };
  }

  /** A `scored` signal in the corpus, so the bare-topic branch has something to rank. */
  async function seedScored(id: string, title: string): Promise<void> {
    await ctx.db.insert(sources).values({ id: `src-${id}`, kind: "rss", url: `https://feed.test/${id}` }).run();
    await ctx.db
      .insert(signals)
      .values({ id, sourceId: `src-${id}`, canonicalUrl: `https://example.com/${id}`, title, observedAt: new Date().toISOString(), engagementScore: 1, simhash: "0".repeat(16), state: "scored" })
      .run();
  }

  beforeEach(() => {
    ctx = createTestDb();
    applyMigrations(ctx.client);
    research = vi.fn(() => Promise.resolve({ brief: GROUNDED, provenance: { provider: "gemini-grounded" as const, model: GROUNDED.model, fallbackReason: null } }));
  });

  describe("a specific brief", () => {
    it("mints its own signal, grounds it, and queues a plan naming it", async () => {
      const prepared = await prepareBrief("b1", LONG_PROMPT, deps());

      expect(prepared).not.toBeNull();
      if (prepared === null) return;
      expect(prepared.digest.specificity).toBe("specific");
      expect(prepared.research).toEqual(GROUNDED);
      expect(prepared.researchProvenance?.provider).toBe("gemini-grounded");

      const row = (await ctx.db.select().from(signals).where(eq(signals.id, prepared.signalId)).all())[0];
      expect(row.sourceId).toBe("operator");
      expect(row.state).toBe("scored");
      expect(row.canonicalUrl).toBe("operator://brief/b1");
    });

    it("queues exactly one pick, on DIGEST's topic, and a render can claim it", async () => {
      const prepared = await prepareBrief("b1", LONG_PROMPT, deps());
      if (prepared === null) throw new Error("expected a prepared brief");

      const queued = await listQueuedPicks(ctx.db);
      expect(queued).toHaveLength(1);
      expect(queued[0].topic).toBe("ai");

      // The gate the whole design rests on: `claimedPick.topic` reaching PLAN,
      // SOURCE and EXPORT unchanged.
      const claimed = await claimNextRunPick(ctx.db, "trace-1", new Date().toISOString(), prepared.planId);
      expect(claimed?.signalId).toBe(prepared.signalId);
    });

    it("carries a named voice and language out for the render to apply", async () => {
      const prepared = await prepareBrief("b1", LONG_PROMPT, deps());
      expect(prepared?.digest.voice).toBe("Puck");
      expect(prepared?.digest.language).toBe("Spanish");
    });

    it("continues with no research when grounding fails — the render then tries the corpus path", async () => {
      const prepared = await prepareBrief("b1", LONG_PROMPT, deps({ research: () => Promise.resolve(null) }));

      expect(prepared?.research).toBeNull();
      expect(prepared?.researchProvenance).toBeNull();
      // The signal and the plan still exist: the corpus path has something to
      // work against, and the video is still made.
      expect(await listQueuedPicks(ctx.db)).toHaveLength(1);
    });
  });

  describe("a bare topic", () => {
    it("takes the rank-1 idea for the topic and never mints a signal", async () => {
      await seedScored("sig-ai-1", "OpenAI ships a new model and the argument restarts");
      await seedScored("sig-ai-2", "A quieter story about an ai chatbot");

      const prepared = await prepareBrief("b1", "make a video on AI", deps());

      expect(prepared?.digest.specificity).toBe("topic_only");
      expect(prepared?.signalId).toMatch(/^sig-ai-/);
      // Nothing synthetic was written: the corpus supplied the story.
      expect((await ctx.db.select().from(sources).where(eq(sources.id, "operator")).all())).toHaveLength(0);
    });

    it("never calls the grounded researcher — that branch is the corpus's", async () => {
      await seedScored("sig-ai-1", "OpenAI ships a new model and the argument restarts");
      await prepareBrief("b1", "make a video on AI", deps());
      expect(research).not.toHaveBeenCalled();
    });

    it("is deterministic: the same corpus and topic give the same story every time", async () => {
      await seedScored("sig-ai-1", "OpenAI ships a new model and the argument restarts");
      await seedScored("sig-ai-2", "Another ai model story, less matched");

      const first = await prepareBrief("b1", "make a video on AI", deps());
      const second = await prepareBrief("b2", "make a video on AI", deps());

      expect(second?.signalId).toBe(first?.signalId);
    });

    it("returns null rather than building nothing-in-particular when the corpus is empty", async () => {
      expect(await prepareBrief("b1", "make a video on AI", deps())).toBeNull();
      // And nothing was queued, so no render is dispatched against a plan that
      // names no story.
      expect(await listQueuedPicks(ctx.db)).toHaveLength(0);
    });

    it("takes the same branch when DIGEST itself failed", async () => {
      await seedScored("sig-ai-1", "OpenAI ships a new ai model and the argument restarts");
      const failure: DriverError = { kind: "rate_limited", message: "HTTP 429", retryable: true };

      const prepared = await prepareBrief("b1", LONG_PROMPT, deps({ digestLlm: fakeLlm(failure) }));

      expect(prepared?.digest.specificity).toBe("topic_only");
      expect(prepared?.digestDegradedReason).toContain("rate_limited");
      expect(prepared?.signalId).toBe("sig-ai-1");
      expect(research).not.toHaveBeenCalled();
    });
  });
});
