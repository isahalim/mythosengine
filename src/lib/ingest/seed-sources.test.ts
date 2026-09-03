import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../../../db/apply-migrations.ts";
import { createTestDb } from "../../../db/client.ts";
import { sources } from "../../../db/schema.ts";
import { seedSourcesFromYaml } from "./seed-sources.ts";

const realSourcesYaml = readFileSync(join(import.meta.dirname, "..", "..", "..", "data", "sources.yml"), "utf8");

describe("seedSourcesFromYaml", () => {
  let ctx: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    ctx = createTestDb();
    applyMigrations(ctx.client);
  });

  afterEach(() => {
    ctx.client.close();
  });

  it("loads the real committed data/sources.yml without error", async () => {
    const result = await seedSourcesFromYaml(ctx.db, ctx.client, realSourcesYaml);
    expect(result.inserted).toBeGreaterThan(0);
    const rows = ctx.db.select().from(sources).all();
    expect(rows.length).toBe(result.inserted);
    expect(rows.every((r) => r.enabled === 1)).toBe(true);
  });

  it("is idempotent: seeding twice does not duplicate or error", async () => {
    await seedSourcesFromYaml(ctx.db, ctx.client, realSourcesYaml);
    const second = await seedSourcesFromYaml(ctx.db, ctx.client, realSourcesYaml);
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBeGreaterThan(0);
  });

  it("respects an explicit enabled: false", async () => {
    const yaml = `sources:\n  - id: x\n    kind: rss\n    url: https://example.com/feed.xml\n    enabled: false\n`;
    await seedSourcesFromYaml(ctx.db, ctx.client, yaml);
    const row = ctx.db.select().from(sources).all()[0];
    expect(row.enabled).toBe(0);
  });

  it("throws on an invalid kind rather than silently accepting it, before writing anything", async () => {
    const yaml = `sources:\n  - id: ok\n    kind: rss\n    url: https://example.com/a.xml\n  - id: bad\n    kind: not-a-real-kind\n    url: https://example.com/b\n`;
    await expect(seedSourcesFromYaml(ctx.db, ctx.client, yaml)).rejects.toThrow(/invalid kind/);
    // The valid entry ahead of the bad one must not have been written.
    expect(ctx.db.select().from(sources).all()).toEqual([]);
  });

  it("throws on a document that isn't shaped like a sources file", async () => {
    await expect(seedSourcesFromYaml(ctx.db, ctx.client, "not: a sources file\n")).rejects.toThrow();
  });

  /**
   * Existing rows used to be skipped outright, so an edited URL never
   * reached a database that had already been seeded — the file and the table
   * would disagree silently and forever. Found moving Reddit from `hot.rss`
   * to `rising.rss` on 2026-09-03, which would otherwise have been a no-op
   * in production.
   */
  describe("reconciling rows that already exist", () => {
    const before = `sources:\n  - id: r\n    kind: rss\n    url: https://www.reddit.com/r/AskReddit/hot.rss\n`;

    it("re-points a changed url and counts it as an update, not a skip", async () => {
      await seedSourcesFromYaml(ctx.db, ctx.client, before);
      const after = `sources:\n  - id: r\n    kind: rss\n    url: https://www.reddit.com/r/AskReddit/rising.rss\n`;

      const result = await seedSourcesFromYaml(ctx.db, ctx.client, after);

      expect(result).toEqual({ inserted: 0, updated: 1, skipped: 0 });
      expect(ctx.db.select().from(sources).all()[0].url).toBe("https://www.reddit.com/r/AskReddit/rising.rss");
    });

    it("drops the conditional-GET validators when the url changes", async () => {
      await seedSourcesFromYaml(ctx.db, ctx.client, before);
      ctx.client.exec(`UPDATE sources SET etag = '"abc"', last_modified = 'Wed, 03 Sep 2026 00:00:00 GMT' WHERE id = 'r'`);

      await seedSourcesFromYaml(ctx.db, ctx.client, `sources:\n  - id: r\n    kind: rss\n    url: https://www.reddit.com/r/AskReddit/rising.rss\n`);

      // An If-Modified-Since built for the old feed can earn a 304 from the
      // new one, which is a source that looks polled and is permanently empty.
      const row = ctx.db.select().from(sources).all()[0];
      expect(row.etag).toBeNull();
      expect(row.lastModified).toBeNull();
    });

    it("keeps the validators when only `enabled` changes", async () => {
      await seedSourcesFromYaml(ctx.db, ctx.client, before);
      ctx.client.exec(`UPDATE sources SET etag = '"abc"' WHERE id = 'r'`);

      const result = await seedSourcesFromYaml(ctx.db, ctx.client, `${before.trimEnd()}\n    enabled: false\n`);

      // Toggling a flag is not a new resource; throwing away a working
      // conditional GET would re-download the feed for nothing.
      expect(result.updated).toBe(1);
      const row = ctx.db.select().from(sources).all()[0];
      expect(row.enabled).toBe(0);
      expect(row.etag).toBe('"abc"');
    });

    it("still reports an unchanged file as entirely skipped", async () => {
      await seedSourcesFromYaml(ctx.db, ctx.client, realSourcesYaml);
      expect(await seedSourcesFromYaml(ctx.db, ctx.client, realSourcesYaml)).toMatchObject({ inserted: 0, updated: 0 });
    });
  });
});
