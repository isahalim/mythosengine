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
});
