import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../../../db/apply-migrations.ts";
import { createTestDb } from "../../../db/client.ts";
import { signals, sources } from "../../../db/schema.ts";
import { watchAllEnabledSources, watchSource } from "./watch.ts";

const fixturesDir = join(import.meta.dirname, "__fixtures__");
const readFixture = (name: string) => readFileSync(join(fixturesDir, name), "utf8");

function fakeFetch(response: Response): typeof fetch {
  return (async () => response.clone()) as typeof fetch;
}

describe("watchSource", () => {
  let ctx: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    ctx = createTestDb();
    applyMigrations(ctx.client);
    ctx.db.insert(sources).values({ id: "bbc", kind: "rss", url: "https://example.com/bbc.xml" }).run();
  });

  afterEach(() => {
    ctx.client.close();
  });

  it("inserts new signals from a real feed sample, in the observed state", async () => {
    const source = ctx.db.select().from(sources).all()[0];
    const response = new Response(readFixture("real-bbc-sample.xml"), { status: 200 });
    const result = await watchSource(ctx.db, source, { fetchImpl: fakeFetch(response) });

    expect(result.status).toBe("fetched");
    expect(result.itemsObserved).toBe(2);

    const rows = ctx.db.select().from(signals).all();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.state === "observed")).toBe(true);
  });

  it("is idempotent: watching the same feed twice does not duplicate signals", async () => {
    const source = ctx.db.select().from(sources).all()[0];
    const response = () => new Response(readFixture("real-bbc-sample.xml"), { status: 200 });

    await watchSource(ctx.db, source, { fetchImpl: fakeFetch(response()) });
    const second = await watchSource(ctx.db, source, { fetchImpl: fakeFetch(response()) });

    expect(second.itemsObserved).toBe(0); // both already existed
    const rows = ctx.db.select().from(signals).all();
    expect(rows).toHaveLength(2);
  });

  it("stores the ETag/Last-Modified from the response for the next conditional GET", async () => {
    const source = ctx.db.select().from(sources).all()[0];
    const response = new Response(readFixture("real-bbc-sample.xml"), {
      status: 200,
      headers: { etag: '"abc123"', "last-modified": "Thu, 27 Aug 2026 00:00:00 GMT" },
    });
    await watchSource(ctx.db, source, { fetchImpl: fakeFetch(response) });

    const updated = ctx.db.select().from(sources).all()[0];
    expect(updated.etag).toBe('"abc123"');
    expect(updated.lastModified).toBe("Thu, 27 Aug 2026 00:00:00 GMT");
  });

  it("treats a 304 as unchanged and writes nothing", async () => {
    const source = ctx.db.select().from(sources).all()[0];
    const response = new Response(null, { status: 304 });
    const result = await watchSource(ctx.db, source, { fetchImpl: fakeFetch(response) });

    expect(result.status).toBe("unchanged");
    expect(ctx.db.select().from(signals).all()).toHaveLength(0);
  });

  it("fails cleanly (not a throw) on malformed feed XML", async () => {
    const source = ctx.db.select().from(sources).all()[0];
    const response = new Response(readFixture("malformed.xml"), { status: 200 });
    const result = await watchSource(ctx.db, source, { fetchImpl: fakeFetch(response) });

    expect(result.status).toBe("failed");
    expect(result.error?.kind).toBe("invalid_response");
  });

  it("handles a well-formed but empty feed without error", async () => {
    const source = ctx.db.select().from(sources).all()[0];
    const response = new Response(readFixture("empty-feed.xml"), { status: 200 });
    const result = await watchSource(ctx.db, source, { fetchImpl: fakeFetch(response) });

    expect(result.status).toBe("fetched");
    expect(result.itemsObserved).toBe(0);
  });

  it("reports failed with the driver error when the fetch itself fails", async () => {
    const source = ctx.db.select().from(sources).all()[0];
    const alwaysFail: typeof fetch = (async () => new Response(null, { status: 500 })) as typeof fetch;
    const result = await watchSource(ctx.db, source, { fetchImpl: alwaysFail, timeoutMs: 200 });

    expect(result.status).toBe("failed");
    expect(result.error?.kind).toBe("provider_error");
  });
});

describe("watchAllEnabledSources", () => {
  let ctx: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    ctx = createTestDb();
    applyMigrations(ctx.client);
    ctx.db.insert(sources).values([
      { id: "enabled-1", kind: "rss", url: "https://example.com/a.xml", enabled: 1 },
      { id: "enabled-2", kind: "rss", url: "https://example.com/b.xml", enabled: 1 },
      { id: "disabled", kind: "rss", url: "https://example.com/c.xml", enabled: 0 },
    ]).run();
  });

  afterEach(() => {
    ctx.client.close();
  });

  it("watches every enabled source and skips disabled ones", async () => {
    const response = () => new Response(readFixture("real-bbc-sample.xml"), { status: 200 });
    const results = await watchAllEnabledSources(ctx.db, { fetchImpl: fakeFetch(response()) });

    expect(results.map((r) => r.sourceId).sort()).toEqual(["enabled-1", "enabled-2"]);
  });
});
