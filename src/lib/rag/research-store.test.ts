import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigrations } from "../../../db/apply-migrations.ts";
import { createTestDb } from "../../../db/client.ts";
import { researchBriefs, signals, sources } from "../../../db/schema.ts";
import type { ResearchBrief } from "./research.ts";
import { getLatestResearchBrief, saveResearchBrief } from "./research-store.ts";

const BRIEF: ResearchBrief = {
  summary: "Rockstar delayed GTA VI and the market reacted.",
  keyPoints: ["Second delay", "Analysts cut targets"],
  citations: [{ signalId: "sig1", claim: "Rockstar confirmed 2027", title: "GTA VI delayed", url: "https://news.example.com/1", sourceKind: "rss" }],
  toolCallsMade: ["search_discourse", "read_source"],
  model: "openai/gpt-oss-20b",
};

describe("research brief persistence", () => {
  let ctx: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    ctx = createTestDb();
    applyMigrations(ctx.client);
    ctx.db.insert(sources).values({ id: "rss1", kind: "rss", url: "https://news.example.com/feed" }).run();
    ctx.db
      .insert(signals)
      .values({ id: "sig1", sourceId: "rss1", canonicalUrl: "https://news.example.com/1", title: "GTA VI delayed", observedAt: "2026-08-30T10:00:00Z", engagementScore: 9, simhash: "a", state: "scored" })
      .run();
  });

  afterEach(() => {
    ctx.client.close();
  });

  it("round-trips a brief with its citations intact", async () => {
    await saveResearchBrief(ctx.db, "sig1", BRIEF, () => Date.parse("2026-08-30T12:00:00Z"));

    const loaded = await getLatestResearchBrief(ctx.db, "sig1");
    expect(loaded).toMatchObject({
      signalId: "sig1",
      summary: BRIEF.summary,
      keyPoints: BRIEF.keyPoints,
      model: "openai/gpt-oss-20b",
      toolCallsMade: ["search_discourse", "read_source"],
      createdAt: "2026-08-30T12:00:00.000Z",
    });
    expect(loaded?.citations[0].url).toBe("https://news.example.com/1");
  });

  it("returns the newest brief when a signal has been researched more than once", async () => {
    await saveResearchBrief(ctx.db, "sig1", BRIEF, () => Date.parse("2026-08-30T12:00:00Z"));
    await saveResearchBrief(ctx.db, "sig1", { ...BRIEF, summary: "A later, better brief." }, () => Date.parse("2026-08-30T13:00:00Z"));

    const loaded = await getLatestResearchBrief(ctx.db, "sig1");
    expect(loaded?.summary).toBe("A later, better brief.");
  });

  it("returns null for a signal that was never researched", async () => {
    expect(await getLatestResearchBrief(ctx.db, "sig1")).toBeNull();
  });

  it("degrades to null and says so out loud when a stored row's JSON is unreadable", async () => {
    // Only reachable if something other than saveResearchBrief wrote the
    // row. It must cost the audit package its research section, not block
    // the operator from downloading a finished video — but it is a real bug
    // and must not pass silently.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await saveResearchBrief(ctx.db, "sig1", BRIEF, () => Date.parse("2026-08-30T12:00:00Z"));
    ctx.db.update(researchBriefs).set({ citationsJson: "{not json" }).run();

    expect(await getLatestResearchBrief(ctx.db, "sig1")).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unreadable JSON"), expect.anything());
    warn.mockRestore();
  });

  it("is removed with its signal, leaving no orphan evidence behind", async () => {
    await saveResearchBrief(ctx.db, "sig1", BRIEF);
    ctx.client.exec("PRAGMA foreign_keys = ON");
    ctx.client.exec("DELETE FROM signals WHERE id = 'sig1'");

    expect(ctx.db.select().from(researchBriefs).all()).toHaveLength(0);
  });
});
