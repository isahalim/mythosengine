import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "./apply-migrations.ts";
import { createTestDb } from "./client.ts";
import { claimNextFootageSegment } from "./footage-select.ts";
import { footageSegments, footageSources, signals, sources } from "./schema.ts";

describe("schema + migrations", () => {
  let ctx: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    ctx = createTestDb();
    applyMigrations(ctx.client);
  });

  afterEach(() => {
    ctx.client.close();
  });

  it("creates every table from the committed migration", () => {
    const rows = ctx.client
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = rows.map((r) => r.name);
    for (const table of [
      "sources",
      "signals",
      "scripts",
      "footage_sources",
      "footage_segments",
      "renders",
      "exports",
      "runs",
      "audit_log",
      "directives",
      "credentials",
    ]) {
      expect(names).toContain(table);
    }
  });

  it("rejects an out-of-enum value via the CHECK constraint, at the DB layer", () => {
    expect(() => {
      ctx.client.prepare("INSERT INTO sources (id, kind, url) VALUES (?, ?, ?)").run("s1", "not-a-real-kind", "http://x");
    }).toThrow(/CHECK constraint failed/);
  });

  it("rejects clip_end_s <= clip_start_s via the CHECK constraint", () => {
    ctx.db.insert(footageSources).values({ id: "fsrc1", channelUrl: "http://x", game: "minecraft", licenseNote: "owned" }).run();
    expect(() => {
      ctx.db
        .insert(footageSegments)
        .values({
          id: "seg1",
          footageSourceId: "fsrc1",
          sourceVideoId: "vid1",
          clipStartS: 30,
          clipEndS: 10,
          motionScore: 0.5,
          libraryPath: "clips/seg1.mp4",
          fetchedAt: new Date().toISOString(),
        })
        .run();
    }).toThrow(/CHECK constraint failed/);
  });

  it("idempotent insert: retrying the same (source_id, canonical_url) yields exactly one row", () => {
    ctx.db.insert(sources).values({ id: "src1", kind: "reddit", url: "http://reddit.example" }).run();

    const insertSignal = () =>
      ctx.db
        .insert(signals)
        .values({
          id: "sig1",
          sourceId: "src1",
          canonicalUrl: "http://example.com/thread/1",
          title: "some thread",
          observedAt: new Date().toISOString(),
          engagementScore: 1,
          simhash: "abc",
          state: "observed",
        })
        .onConflictDoNothing()
        .run();

    insertSignal();
    insertSignal(); // simulates a retried WATCH run over the same item

    const rows = ctx.db.select().from(signals).all();
    expect(rows).toHaveLength(1);
  });

  it("a partially-failed multi-table write leaves zero rows (transaction rollback)", () => {
    ctx.db.insert(sources).values({ id: "src1", kind: "reddit", url: "http://reddit.example" }).run();

    expect(() => {
      ctx.db.transaction((tx) => {
        tx.insert(signals)
          .values({
            id: "sig1",
            sourceId: "src1",
            canonicalUrl: "http://example.com/thread/1",
            title: "some thread",
            observedAt: new Date().toISOString(),
            engagementScore: 1,
            simhash: "abc",
            state: "observed",
          })
          .run();

        // Second write in the same transaction violates the CHECK constraint —
        // the whole transaction must roll back, not just this statement.
        tx.run(sql`INSERT INTO signals (id, source_id, canonical_url, title, observed_at, engagement_score, simhash, state)
                   VALUES ('sig2', 'src1', 'http://example.com/thread/2', 't', '2026-01-01', 1, 'abc', 'not-a-real-state')`);
      });
    }).toThrow();

    const rows = ctx.db.select().from(signals).all();
    expect(rows).toHaveLength(0);
  });
});

describe("claimNextFootageSegment", () => {
  let ctx: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    ctx = createTestDb();
    applyMigrations(ctx.client);
    ctx.db.insert(footageSources).values({ id: "fsrc1", channelUrl: "http://x", game: "minecraft", licenseNote: "owned" }).run();
    ctx.db
      .insert(footageSegments)
      .values([
        { id: "seg1", footageSourceId: "fsrc1", sourceVideoId: "v1", clipStartS: 0, clipEndS: 20, motionScore: 0.9, libraryPath: "a", fetchedAt: "2026-01-01" },
        { id: "seg2", footageSourceId: "fsrc1", sourceVideoId: "v1", clipStartS: 20, clipEndS: 40, motionScore: 0.8, libraryPath: "b", fetchedAt: "2026-01-01" },
      ])
      .run();
  });

  afterEach(() => {
    ctx.client.close();
  });

  it("rotates: two successive claims for the same game return different segments", async () => {
    const first = await claimNextFootageSegment(ctx.db, "minecraft", "2026-01-02T00:00:00Z");
    const second = await claimNextFootageSegment(ctx.db, "minecraft", "2026-01-02T00:00:01Z");
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first?.id).not.toBe(second?.id);
  });

  it("increments used_count on the claimed row", async () => {
    const claimed = await claimNextFootageSegment(ctx.db, "minecraft", "2026-01-02T00:00:00Z");
    expect(claimed?.usedCount).toBe(1);
  });

  it("returns null when no segments exist for the requested game", async () => {
    const claimed = await claimNextFootageSegment(ctx.db, "subway-surfers", "2026-01-02T00:00:00Z");
    expect(claimed).toBeNull();
  });
});
