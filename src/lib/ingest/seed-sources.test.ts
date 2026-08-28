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

  it("loads the real committed data/sources.yml without error", () => {
    const result = seedSourcesFromYaml(ctx.db, realSourcesYaml);
    expect(result.inserted).toBeGreaterThan(0);
    const rows = ctx.db.select().from(sources).all();
    expect(rows.length).toBe(result.inserted);
    expect(rows.every((r) => r.enabled === 1)).toBe(true);
  });

  it("is idempotent: seeding twice does not duplicate or error", () => {
    seedSourcesFromYaml(ctx.db, realSourcesYaml);
    const second = seedSourcesFromYaml(ctx.db, realSourcesYaml);
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBeGreaterThan(0);
  });

  it("respects an explicit enabled: false", () => {
    const yaml = `sources:\n  - id: x\n    kind: rss\n    url: https://example.com/feed.xml\n    enabled: false\n`;
    seedSourcesFromYaml(ctx.db, yaml);
    const row = ctx.db.select().from(sources).all()[0];
    expect(row.enabled).toBe(0);
  });

  it("throws on an invalid kind rather than silently accepting it", () => {
    const yaml = `sources:\n  - id: x\n    kind: not-a-real-kind\n    url: https://example.com\n`;
    expect(() => seedSourcesFromYaml(ctx.db, yaml)).toThrow(/invalid kind/);
  });

  it("throws on a document that isn't shaped like a sources file", () => {
    expect(() => seedSourcesFromYaml(ctx.db, "not: a sources file\n")).toThrow();
  });
});
