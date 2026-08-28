import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../../db/client.ts";
import { applyMigrations } from "../../../db/apply-migrations.ts";
import { renders, runs, scripts, signals, sources, footageSources, footageSegments } from "../../../db/schema.ts";
import { checkAndAlert } from "./rules.ts";

describe("checkAndAlert", () => {
  let ctx: ReturnType<typeof createTestDb>;
  let server: Server;
  let baseUrl: string;
  let receivedMessages: string[];

  beforeEach(async () => {
    ctx = createTestDb();
    applyMigrations(ctx.client);
    receivedMessages = [];
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        receivedMessages.push((JSON.parse(raw) as { content: string }).content);
        res.writeHead(204);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected network address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(() => {
    server.close();
  });

  it("fires nothing on a quiet install", async () => {
    const result = await checkAndAlert(ctx.db, baseUrl);
    expect(result.fired).toEqual([]);
    expect(receivedMessages).toEqual([]);
  });

  it("alerts when Edge TTS has failed 2 runs in a row", async () => {
    const now = Date.now();
    await ctx.db
      .insert(runs)
      .values([
        { id: "r1", startedAt: new Date(now).toISOString(), stage: "tts", status: "failed", traceId: "r1" },
        { id: "r2", startedAt: new Date(now - 1000).toISOString(), stage: "tts", status: "failed", traceId: "r2" },
      ])
      .run();

    const result = await checkAndAlert(ctx.db, baseUrl, () => now);
    expect(result.fired).toContain("tts_failing");
    expect(receivedMessages.some((m) => m.includes("2 runs in a row"))).toBe(true);
  });

  it("does not alert on TTS when the most recent run succeeded, even if an earlier one failed", async () => {
    const now = Date.now();
    await ctx.db
      .insert(runs)
      .values([
        { id: "r1", startedAt: new Date(now).toISOString(), stage: "tts", status: "ok", traceId: "r1" },
        { id: "r2", startedAt: new Date(now - 1000).toISOString(), stage: "tts", status: "failed", traceId: "r2" },
      ])
      .run();

    const result = await checkAndAlert(ctx.db, baseUrl, () => now);
    expect(result.fired).not.toContain("tts_failing");
  });

  it("alerts on audit flag rate above 20% in the last 24h", async () => {
    const now = Date.now();
    await ctx.db.insert(sources).values({ id: "src1", kind: "reddit", url: "http://x" }).run();
    await ctx.db.insert(footageSources).values({ id: "fsrc1", channelUrl: "http://y", game: "minecraft", licenseNote: "owned" }).run();
    await ctx.db.insert(footageSegments).values({ id: "fseg1", footageSourceId: "fsrc1", sourceVideoId: "v1", clipStartS: 0, clipEndS: 10, motionScore: 1, libraryPath: "p", fetchedAt: "2026-01-01" }).run();

    for (let i = 0; i < 5; i++) {
      await ctx.db.insert(signals).values({ id: `sig${i}`, sourceId: "src1", canonicalUrl: `http://x/${i}`, title: "t", observedAt: "2026-01-01", engagementScore: 1, simhash: `s${i}`, state: "exported" }).run();
      await ctx.db.insert(scripts).values({ id: `scr${i}`, signalId: `sig${i}`, hook: "h", body: "b", debateQuestion: "q", wordCount: 10, status: "approved", createdAt: "2026-01-01" }).run();
      await ctx.db
        .insert(renders)
        .values({
          id: `ren${i}`,
          scriptId: `scr${i}`,
          footageSegmentId: "fseg1",
          ttsDriver: "edge",
          ttsVoice: "v",
          status: "rendered",
          createdAt: new Date(now).toISOString(),
          auditResult: i < 2 ? JSON.stringify({ flags: ["low_originality"] }) : JSON.stringify({ flags: [] }),
        })
        .run();
    }

    const result = await checkAndAlert(ctx.db, baseUrl, () => now);
    expect(result.fired).toContain("audit_flag_rate");
  });
});
