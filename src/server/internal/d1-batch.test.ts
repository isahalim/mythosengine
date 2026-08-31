import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, getOne } from "../../../db/client.ts";
import { applyMigrations } from "../../../db/apply-migrations.ts";
import { auditLog, footageSources } from "../../../db/schema.ts";
import { handleD1Batch, MAX_PARAMS, MAX_SQL_BYTES, MAX_STATEMENTS, parseBatchBody, type D1BatchDeps } from "./d1-batch.ts";

const TOKEN = "pbt_" + "c".repeat(48);

function request(body: unknown, token: string | null = TOKEN): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  return new Request("https://example.workers.dev/internal/d1/batch", { method: "POST", headers, body: JSON.stringify(body) });
}

function insertSource(id: string) {
  return {
    sql: "insert into footage_sources (id, game, channel_url, license_note, enabled) values (?, ?, ?, ?, ?)",
    params: [id, "gta-v", `https://youtube.com/@${id}`, "test", 1],
  };
}

describe("parseBatchBody", () => {
  it("accepts a well-formed batch", () => {
    const result = parseBatchBody({ statements: [{ sql: "update x set y = ?", params: [1] }] });
    expect(result.ok).toBe(true);
  });

  it.each([
    ["a non-object body", "nope"],
    ["a missing statements array", {}],
    ["an empty batch", { statements: [] }],
    ["a statement that isn't an object", { statements: ["delete from x"] }],
    ["a statement with no sql", { statements: [{ params: [] }] }],
    ["a statement with blank sql", { statements: [{ sql: "   ", params: [] }] }],
    ["params that aren't an array", { statements: [{ sql: "select 1", params: "1" }] }],
  ])("rejects %s", (_label, body) => {
    expect(parseBatchBody(body).ok).toBe(false);
  });

  it("refuses a batch past the statement cap rather than executing part of it", () => {
    const statements = Array.from({ length: MAX_STATEMENTS + 1 }, () => ({ sql: "select 1", params: [] }));
    const result = parseBatchBody({ statements });
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.error).toContain("limit");
  });

  it("refuses an oversized SQL payload", () => {
    const result = parseBatchBody({ statements: [{ sql: "x".repeat(MAX_SQL_BYTES + 1), params: [] }] });
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.error).toContain("bytes");
  });

  it("refuses a batch carrying more parameters than the cap, counted across every statement", () => {
    // Counted in total, not per statement: splitting one huge write across
    // many small ones must not slip past the cap.
    const statements = Array.from({ length: 8 }, () => ({ sql: "insert into x values (?)", params: Array.from({ length: MAX_PARAMS / 4 }, () => 1) }));
    const result = parseBatchBody({ statements });
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.error).toContain("parameters");
  });
});

describe("POST /internal/d1/batch", () => {
  let ctx: ReturnType<typeof createTestDb>;
  let deps: D1BatchDeps;

  beforeEach(() => {
    ctx = createTestDb();
    applyMigrations(ctx.client);
    deps = { db: ctx.db, rawClient: ctx.client, pipelineBatchToken: TOKEN };
  });

  it("commits every statement in the batch", async () => {
    const response = await handleD1Batch(request({ statements: [insertSource("a"), insertSource("b")] }), deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, statements: 2 });
    expect(await getOne(ctx.db.select().from(footageSources).where(eq(footageSources.id, "a")))).toBeDefined();
    expect(await getOne(ctx.db.select().from(footageSources).where(eq(footageSources.id, "b")))).toBeDefined();
  });

  it("is atomic: a batch whose second statement fails leaves the first uncommitted", async () => {
    // This is the whole reason the endpoint exists — CLAUDE.md forbids a
    // multi-step mutation outside a transaction, and the REST API this
    // replaced could not give us one.
    const bad = { sql: "insert into footage_sources (id) values (?)", params: ["missing-required-columns"] };
    const response = await handleD1Batch(request({ statements: [insertSource("first"), bad] }), deps);
    expect(response.status).toBe(500);
    expect(await getOne(ctx.db.select().from(footageSources).where(eq(footageSources.id, "first")))).toBeUndefined();
  });

  it("returns the database's own explanation instead of a bare 500", async () => {
    const response = await handleD1Batch(request({ statements: [{ sql: "insert into nonexistent_table values (1)", params: [] }] }), deps);
    const body = (await response.json()) as { error: string; detail: string };
    expect(body.error).toBe("batch_failed");
    expect(body.detail).toContain("nonexistent_table");
  });

  it("rejects a request with no bearer token", async () => {
    const response = await handleD1Batch(request({ statements: [insertSource("a")] }, null), deps);
    expect(response.status).toBe(401);
  });

  it("rejects a wrong token, and writes nothing", async () => {
    const response = await handleD1Batch(request({ statements: [insertSource("a")] }, "pbt_" + "d".repeat(48)), deps);
    expect(response.status).toBe(401);
    expect(await getOne(ctx.db.select().from(footageSources).where(eq(footageSources.id, "a")))).toBeUndefined();
  });

  it("rejects a token that is merely a prefix of the real one", async () => {
    const response = await handleD1Batch(request({ statements: [insertSource("a")] }, TOKEN.slice(0, -1)), deps);
    expect(response.status).toBe(401);
  });

  it("fails closed when the Worker has no token configured — an unset secret must never open the endpoint", async () => {
    for (const missing of [undefined, ""]) {
      const response = await handleD1Batch(request({ statements: [insertSource("a")] }), { ...deps, pipelineBatchToken: missing });
      expect(response.status).toBe(503);
      expect(await getOne(ctx.db.select().from(footageSources).where(eq(footageSources.id, "a")))).toBeUndefined();
    }
  });

  it("rejects a malformed body before touching the database", async () => {
    const bad = new Request("https://example.workers.dev/internal/d1/batch", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: "{not json",
    });
    expect((await handleD1Batch(bad, deps)).status).toBe(400);
    expect((await handleD1Batch(request({ statements: [] }), deps)).status).toBe(400);
  });

  it("audits the call with the SQL but never the bound parameters", async () => {
    await handleD1Batch(request({ statements: [insertSource("secret-looking-value")] }), deps);
    const entry = await getOne(ctx.db.select().from(auditLog).where(eq(auditLog.action, "d1.batch")));
    expect(entry).toBeDefined();
    expect(entry?.actor).toBe("pipeline");
    expect(entry?.detailJson).toContain("insert into footage_sources");
    // Parameters are the payload; an audit row records what ran, not the data.
    expect(entry?.detailJson).not.toContain("secret-looking-value");
  });
});
