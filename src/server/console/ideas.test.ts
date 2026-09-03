import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../../db/client.ts";
import { applyMigrations } from "../../../db/apply-migrations.ts";
import { signals, sources } from "../../../db/schema.ts";
import { isTopic, rankIdeas, TOPICS } from "./ideas.ts";

type SignalSeed = { id: string; title: string; engagement?: number; state?: "observed" | "scored" | "scripted"; observedAt?: string };

describe("rankIdeas", () => {
  let ctx: ReturnType<typeof createTestDb>;

  async function seed(rows: SignalSeed[]): Promise<void> {
    await ctx.db.insert(sources).values({ id: "src1", kind: "reddit", url: "http://x" }).run();
    await ctx.db
      .insert(signals)
      .values(
        rows.map((row) => ({
          id: row.id,
          sourceId: "src1",
          canonicalUrl: `http://x/${row.id}`,
          title: row.title,
          observedAt: row.observedAt ?? "2026-08-31T00:00:00.000Z",
          engagementScore: row.engagement ?? 1,
          simhash: row.id,
          state: row.state ?? ("scored" as const),
        })),
      )
      .run();
  }

  beforeEach(() => {
    ctx = createTestDb();
    applyMigrations(ctx.client);
  });

  it("returns nothing on an empty corpus rather than a placeholder idea", async () => {
    expect(await rankIdeas(ctx.db, "politics")).toEqual([]);
  });

  it("ranks a topical headline above an unrelated one", async () => {
    await seed([
      { id: "a", title: "Senate votes to block the new surveillance law" },
      { id: "b", title: "Chef reveals the secret to a better omelette" },
    ]);

    const ideas = await rankIdeas(ctx.db, "politics");

    expect(ideas[0]?.signalId).toBe("a");
    expect(ideas.some((idea) => idea.signalId === "b")).toBe(false);
  });

  it("never offers a signal that is not scored", async () => {
    await seed([
      { id: "written", title: "Senate votes on the election bill", state: "scripted" },
      { id: "raw", title: "Senate votes on the election bill again", state: "observed" },
      { id: "ready", title: "Senate election policy vote delayed", state: "scored" },
    ]);

    const ideas = await rankIdeas(ctx.db, "politics");

    expect(ideas.map((idea) => idea.signalId)).toEqual(["ready"]);
  });

  it("lets engagement break a tie between equally topical stories", async () => {
    await seed([
      { id: "quiet", title: "AI model release draws attention", engagement: 1 },
      { id: "loud", title: "AI model release draws attention", engagement: 100 },
    ]);

    const ideas = await rankIdeas(ctx.db, "ai");

    expect(ideas[0]?.signalId).toBe("loud");
  });

  it("does not let engagement alone put an off-topic story under a topic", async () => {
    await seed([
      { id: "offtopic", title: "Footballer scores twice in the derby", engagement: 10_000 },
      { id: "ontopic", title: "Physics study overturns a climate research model", engagement: 1 },
    ]);

    const ideas = await rankIdeas(ctx.db, "science");

    expect(ideas.map((idea) => idea.signalId)).toEqual(["ontopic"]);
  });

  it("excludes the ideas already picked", async () => {
    await seed([
      { id: "a", title: "Senate passes the surveillance law", engagement: 5 },
      { id: "b", title: "Government policy vote splits the party", engagement: 4 },
    ]);

    const ideas = await rankIdeas(ctx.db, "politics", 5, ["a"]);

    expect(ideas.map((idea) => idea.signalId)).toEqual(["b"]);
  });

  it("honours the limit", async () => {
    await seed(Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, title: `Election policy vote number ${i}` })));

    expect(await rankIdeas(ctx.db, "politics", 3)).toHaveLength(3);
  });

  it("reports the relevance and engagement behind each score", async () => {
    await seed([{ id: "a", title: "Startup launches a privacy-first chip platform", engagement: 7 }]);

    const [idea] = await rankIdeas(ctx.db, "tech");

    expect(idea.matchedTerms).toBeGreaterThan(0);
    expect(idea.engagementScore).toBe(7);
    expect(idea.sourceKind).toBe("reddit");
    expect(idea.url).toBe("http://x/a");
  });

  /**
   * The half of "make stage 4 current" that the ingest cannot do. Until
   * 2026-09-03 the blend said nothing about time at all, so a story from
   * last week outranked one ingested seconds ago whenever it had marginally
   * better term overlap — and the candidate pool is several days deep.
   */
  describe("recency", () => {
    const isoAgo = (ms: number): string => new Date(Date.now() - ms).toISOString();
    const HOUR = 60 * 60 * 1000;

    it("puts a story from minutes ago above an equally relevant one from last week", async () => {
      await seed([
        { id: "old", title: "Senate election policy vote on the surveillance law", observedAt: isoAgo(7 * 24 * HOUR) },
        { id: "new", title: "Senate election policy vote on the surveillance law", observedAt: isoAgo(5 * 60 * 1000) },
      ]);

      expect((await rankIdeas(ctx.db, "politics")).map((i) => i.signalId)).toEqual(["new", "old"]);
    });

    it("does not let a fresh irrelevant story outrank a strong older one", async () => {
      // Recency is a weight, not a filter. A decay steep enough to bury
      // relevance would just be sorting by `observedAt` with extra steps.
      await seed([
        { id: "strong", title: "Senate election policy vote government law president", engagement: 9, observedAt: isoAgo(20 * HOUR) },
        { id: "weak", title: "Local council vote delayed", engagement: 1, observedAt: isoAgo(60 * 1000) },
      ]);

      expect((await rankIdeas(ctx.db, "politics"))[0].signalId).toBe("strong");
    });

    it("reports the freshness credit, so the ordering stays inspectable", async () => {
      await seed([{ id: "a", title: "Senate election policy vote", observedAt: isoAgo(12 * HOUR) }]);

      // One half-life in, by construction.
      const [idea] = await rankIdeas(ctx.db, "politics");
      expect(idea.freshness).toBeCloseTo(0.5, 2);
    });

    it("scores a future-dated row no higher than a brand new one", async () => {
      // SCORE already rejects these as a feed bug; nothing here should be
      // able to hand one a credit above 1 and float it to the top anyway.
      await seed([{ id: "future", title: "Senate election policy vote", observedAt: new Date(Date.now() + 48 * HOUR).toISOString() }]);

      expect((await rankIdeas(ctx.db, "politics"))[0].freshness).toBeLessThanOrEqual(1);
    });
  });
});

describe("isTopic", () => {
  it("accepts every offered topic and nothing else", () => {
    for (const topic of TOPICS) expect(isTopic(topic)).toBe(true);
    expect(isTopic("sports")).toBe(false);
    expect(isTopic("")).toBe(false);
  });
});
