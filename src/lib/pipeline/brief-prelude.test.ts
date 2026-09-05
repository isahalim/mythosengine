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
 * process. The prelude's logic moved here so it could be caught by a test.
 *
 * The other thing it now pins down is the absence of a branch. Until
 * 2026-09-05 a brief DIGEST called vague was replaced by `rankIdeas`' top
 * story for its topic, and a prompt naming a specific trial came back as an
 * unrelated politics video. Every test below asserts the same thing from a
 * different angle: what the operator typed is what gets built.
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

  /** A `scored` signal in the corpus — here to prove the prelude does NOT reach for one. */
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

  describe("every brief", () => {
    it("mints its own signal, grounds it, and queues a plan naming it", async () => {
      const prepared = await prepareBrief("b1", LONG_PROMPT, deps());

      expect(prepared.research).toEqual(GROUNDED);
      expect(prepared.researchProvenance?.provider).toBe("gemini-grounded");

      const row = (await ctx.db.select().from(signals).where(eq(signals.id, prepared.signalId)).all())[0];
      expect(row.sourceId).toBe("operator");
      expect(row.state).toBe("scored");
      expect(row.canonicalUrl).toBe("operator://brief/b1");
    });

    it("queues exactly one pick, on DIGEST's topic, and a render can claim it", async () => {
      const prepared = await prepareBrief("b1", LONG_PROMPT, deps());

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
      expect(prepared.digest.voice).toBe("Puck");
      expect(prepared.digest.language).toBe("Spanish");
    });

    it("continues with no research when grounding fails — the render then tries the corpus path", async () => {
      const prepared = await prepareBrief("b1", LONG_PROMPT, deps({ research: () => Promise.resolve(null) }));

      expect(prepared.research).toBeNull();
      expect(prepared.researchProvenance).toBeNull();
      // The signal and the plan still exist: the corpus path has something to
      // work against, and the video is still made.
      expect(await listQueuedPicks(ctx.db)).toHaveLength(1);
    });
  });

  describe("a vague brief", () => {
    /**
     * The 2026-09-05 bug, end to end. This exact prompt, against a corpus
     * holding a better-scoring politics story, used to come back as that
     * story. The corpus is seeded here precisely so the test would fail if
     * the ranked-idea branch ever came back.
     */
    it("builds the operator's own subject even when the corpus has a story it likes better", async () => {
      await seedScored("sig-pol-1", "A million-pound donor row consumes the government");
      const digest = JSON.stringify({ topic: "politics", title: "The Lindsay Clancy trial", angle: "", must_include: [], voice: null, language: null });

      const prepared = await prepareBrief("b1", "make a video on the lindsay clancy trial", deps({ digestLlm: fakeLlm(digest) }));

      expect(prepared.signalId).not.toBe("sig-pol-1");
      const row = (await ctx.db.select().from(signals).where(eq(signals.id, prepared.signalId)).all())[0];
      expect(row.title).toBe("The Lindsay Clancy trial");
      expect(row.sourceId).toBe("operator");
    });

    it("still grounds a bare subject rather than skipping research for it", async () => {
      const digest = JSON.stringify({ topic: "ai", title: "AI", angle: "", must_include: [], voice: null, language: null });
      await prepareBrief("b1", "make a video on AI", deps({ digestLlm: fakeLlm(digest) }));

      expect(research).toHaveBeenCalledWith({ title: "AI", angle: "", mustInclude: [] });
    });

    it("builds something with an empty corpus, where the old branch built nothing at all", async () => {
      const prepared = await prepareBrief("b1", "make a video on AI", deps());

      expect(prepared.signalId).not.toBe("");
      expect(await listQueuedPicks(ctx.db)).toHaveLength(1);
    });

    it("keeps the operator's words when DIGEST itself failed", async () => {
      await seedScored("sig-ai-1", "OpenAI ships a new ai model and the argument restarts");
      const failure: DriverError = { kind: "rate_limited", message: "HTTP 429", retryable: true };

      const prepared = await prepareBrief("b1", LONG_PROMPT, deps({ digestLlm: fakeLlm(failure) }));

      expect(prepared.digestDegradedReason).toContain("rate_limited");
      expect(prepared.signalId).not.toBe("sig-ai-1");
      const row = (await ctx.db.select().from(signals).where(eq(signals.id, prepared.signalId)).all())[0];
      expect(row.title).toBe(LONG_PROMPT);
      // A degrade costs the brief its classification, not its subject — so
      // research still runs, on the operator's own sentence.
      expect(research).toHaveBeenCalled();
    });
  });
});
