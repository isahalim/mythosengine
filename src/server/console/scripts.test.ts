import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../../db/client.ts";
import { applyMigrations } from "../../../db/apply-migrations.ts";
import { scripts, signals, sources } from "../../../db/schema.ts";
import { approveScript } from "./scripts.ts";

describe("approveScript", () => {
  let ctx: ReturnType<typeof createTestDb>;

  beforeEach(async () => {
    ctx = createTestDb();
    applyMigrations(ctx.client);
    await ctx.db.insert(sources).values({ id: "src1", kind: "reddit", url: "http://x" }).run();
    await ctx.db.insert(signals).values({ id: "sig1", sourceId: "src1", canonicalUrl: "http://x/1", title: "t", observedAt: "2026-01-01", engagementScore: 1, simhash: "a", state: "scripted" }).run();
  });

  it("approves a draft script", async () => {
    await ctx.db.insert(scripts).values({ id: "scr1", signalId: "sig1", hook: "h", body: "b", debateQuestion: "q", wordCount: 10, status: "draft", createdAt: "2026-01-01" }).run();
    const result = await approveScript(ctx.db, "scr1");
    expect(result).toEqual({ kind: "ok" });
  });

  it("refuses to approve an already-approved script", async () => {
    await ctx.db.insert(scripts).values({ id: "scr1", signalId: "sig1", hook: "h", body: "b", debateQuestion: "q", wordCount: 10, status: "approved", createdAt: "2026-01-01" }).run();
    const result = await approveScript(ctx.db, "scr1");
    expect(result).toEqual({ kind: "not_draft" });
  });

  it("returns not_found for an unknown script id", async () => {
    expect(await approveScript(ctx.db, "nope")).toEqual({ kind: "not_found" });
  });
});
