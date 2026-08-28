import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../../db/client.ts";
import { applyMigrations } from "../../../db/apply-migrations.ts";
import { footageSegments, footageSources, signals, sources } from "../../../db/schema.ts";
import { getConsoleSummary } from "./summary.ts";

class FakeKv {
  private readonly store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
}

const MASTER_KEY_B64 = "3q2-7_zdaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("getConsoleSummary", () => {
  let ctx: ReturnType<typeof createTestDb>;
  let kv: FakeKv;

  beforeEach(() => {
    ctx = createTestDb();
    applyMigrations(ctx.client);
    kv = new FakeKv();
  });

  it("reports zeroed pulse counts, default-implied settings, and no fabricated key/TTS status on a fresh install", async () => {
    const summary = await getConsoleSummary(ctx.db, kv, kv, MASTER_KEY_B64);
    expect(summary.pipelinePulse).toMatchObject({ signalsObserved: 0, scripted: 0, rendered: 0, exported: 0, liveRun: null });
    expect(summary.settings.version).toBe(0);
    expect(summary.killswitch.enabled).toBe(true);
    expect(summary.ttsStatus.status).toBe("unknown");
    expect(summary.keys.every((k) => k.status === "down" && k.fingerprint === null)).toBe(true);
  });

  it("buckets recent signals by state into the 24h pulse", async () => {
    const now = Date.now();
    await ctx.db.insert(sources).values({ id: "src1", kind: "reddit", url: "http://x" }).run();
    await ctx.db
      .insert(signals)
      .values([
        { id: "s1", sourceId: "src1", canonicalUrl: "http://x/1", title: "a", observedAt: new Date(now).toISOString(), engagementScore: 1, simhash: "a", state: "observed" },
        { id: "s2", sourceId: "src1", canonicalUrl: "http://x/2", title: "b", observedAt: new Date(now).toISOString(), engagementScore: 1, simhash: "b", state: "scripted" },
        { id: "s3", sourceId: "src1", canonicalUrl: "http://x/3", title: "c", observedAt: new Date(now).toISOString(), engagementScore: 1, simhash: "c", state: "exported" },
      ])
      .run();

    const summary = await getConsoleSummary(ctx.db, kv, kv, MASTER_KEY_B64, () => now);
    expect(summary.pipelinePulse).toMatchObject({ signalsObserved: 3, scripted: 1, exported: 1 });
  });

  it("summarizes footage health per game, flagging low inventory", async () => {
    await ctx.db.insert(footageSources).values({ id: "fsrc1", channelUrl: "http://y", game: "minecraft", licenseNote: "owned" }).run();
    await ctx.db
      .insert(footageSegments)
      .values([
        { id: "seg1", footageSourceId: "fsrc1", sourceVideoId: "v1", clipStartS: 0, clipEndS: 10, motionScore: 1, libraryPath: "p1", usedCount: 8, fetchedAt: "2026-01-01" },
        { id: "seg2", footageSourceId: "fsrc1", sourceVideoId: "v1", clipStartS: 10, clipEndS: 20, motionScore: 1, libraryPath: "p2", usedCount: 4, fetchedAt: "2026-01-01" },
      ])
      .run();

    const summary = await getConsoleSummary(ctx.db, kv, kv, MASTER_KEY_B64);
    expect(summary.footageHealth).toEqual([{ game: "minecraft", segmentCount: 2, avgUsedCount: 6, lowInventory: true }]);
  });
});
