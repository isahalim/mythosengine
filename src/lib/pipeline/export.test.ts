import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuditResult } from "./audit.ts";
import { assembleAuditJson, EXPORT_TTL_SECONDS, runExport, type ExportPackageInput } from "./export.ts";
import { createTestDb } from "../../../db/client.ts";
import { applyMigrations } from "../../../db/apply-migrations.ts";
import { exports as exportsTable, footageSegments, footageSources, renders, scripts, signals, sources } from "../../../db/schema.ts";
import type { DriverError, ExportDriver, ExportStoreRequest, ExportStoreResponse } from "../drivers/types.ts";
import { err, ok, type Result } from "../result.ts";

function fakeExportDriver(behavior: "succeed" | "fail"): ExportDriver {
  return {
    keyFor: (renderId: string) => `exports/${renderId}.mp4`,
    remove: () => Promise.resolve(ok(undefined)),
    store(req: ExportStoreRequest): Promise<Result<ExportStoreResponse, DriverError>> {
      if (behavior === "fail") {
        return Promise.resolve(err({ kind: "provider_error", message: "KV write failed", retryable: false }));
      }
      return Promise.resolve(ok({ key: req.key, sizeBytes: req.bytes.byteLength }));
    },
  };
}

const auditResult: AuditResult = {
  schemaValid: true,
  wordCountInBounds: true,
  narration: null,
  performance: null,
  narrationDowngraded: false,
  characterAbsentReason: null,
  character: null,
  edit: null,
  stages: [],
  hasDebateQuestion: true,
  originalityScore: 0.8,
  clearsOriginalityFloor: true,
  policyFlags: [],
  footage: {
    segmentId: "seg1",
    footageSourceId: "fsrc1",
    sourceVideoId: "v1",
    clipStartS: 0,
    clipEndS: 20,
    usedCount: 1,
    parts: [
      {
        position: 0,
        segmentId: "seg1",
        startMs: 0,
        endMs: 20_000,
        provider: null,
        providerClipId: null,
        photographer: null,
        pageUrl: null,
        searchQuery: null,
        beatIndex: null,
        sourceStartS: 0,
        sourceEndS: 20,
      },
    ],
  },
  footageRecentlyUsed: true,
  research: {
    model: "openai/gpt-oss-20b",
    summary: "What people are arguing about.",
    citations: [{ signalId: "sig9", claim: "the specific thing", title: "Source headline", url: "https://example.com/1", sourceKind: "rss" }],
    toolCallsMade: ["search_discourse"],
  },
  ungrounded: false,
  voiceUsedToday: false,
  scriptSimilarity: null,
  flaggedAsRepeat: false,
  durationMatch: { deltaMs: 10, withinTolerance: true },
  syntheticMediaDisclosureReminder: true,
  flags: [],
};

function packageInput(renderId: string): ExportPackageInput {
  return {
    renderId,
    script: { hook: "hook", body: "body", debateQuestion: "question?" },
    critic: { originalityScore: 0.8, policyFlags: [], verdict: "approved", reason: "genuine angle" },
    footage: auditResult.footage,
    ttsSettings: { voice: "en-US-GuyNeural", rate: "+0%", pitch: "+0Hz", volume: "+0%" },
    auditResult,
    operatorPrompt: null,
    suggestedTitle: "A Title",
    suggestedDescription: "A description.",
    suggestedTags: ["gaming", "shorts"],
  };
}

describe("runExport", () => {
  let ctx: ReturnType<typeof createTestDb>;
  let tmpDir: string;
  let renderFilePath: string;

  beforeEach(async () => {
    ctx = createTestDb();
    applyMigrations(ctx.client);

    ctx.db.insert(sources).values({ id: "src1", kind: "reddit", url: "http://x" }).run();
    ctx.db
      .insert(signals)
      .values({ id: "sig1", sourceId: "src1", canonicalUrl: "http://x/1", title: "t", observedAt: "2026-01-01", engagementScore: 1, simhash: "h", state: "critiqued" })
      .run();
    ctx.db
      .insert(scripts)
      .values({ id: "scr1", signalId: "sig1", hook: "h", body: "b", debateQuestion: "q?", wordCount: 150, status: "approved", createdAt: "2026-01-01" })
      .run();
    ctx.db.insert(footageSources).values({ id: "fsrc1", channelUrl: "http://x", game: "minecraft", licenseNote: "owned" }).run();
    ctx.db
      .insert(footageSegments)
      .values({ id: "seg1", footageSourceId: "fsrc1", sourceVideoId: "v1", clipStartS: 0, clipEndS: 20, motionScore: 0.5, libraryPath: "clips/seg1.mp4", fetchedAt: "2026-01-01" })
      .run();
    ctx.db
      .insert(renders)
      .values({ id: "ren1", scriptId: "scr1", footageSegmentId: "seg1", ttsDriver: "edge-tts", ttsVoice: "en-US-GuyNeural", status: "rendered", createdAt: "2026-01-01" })
      .run();

    tmpDir = await mkdtemp(join(tmpdir(), "export-test-"));
    renderFilePath = join(tmpDir, "ren1.mp4");
    await writeFile(renderFilePath, Buffer.from([1, 2, 3, 4]));
  });

  afterEach(() => {
    ctx.client.close();
  });

  it("stores the file, inserts a ready_for_review exports row, and deletes the local file only on success", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]) as Uint8Array<ArrayBuffer>;
    const result = await runExport(ctx.db, renderFilePath, bytes, packageInput("ren1"), { export: fakeExportDriver("succeed") });

    expect(result.status).toBe("exported");
    expect(result.storageKey).toBe("exports/ren1.mp4");
    expect(result.sizeBytes).toBe(4);

    const rows = ctx.db.select().from(exportsTable).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("ready_for_review");
    expect(rows[0]?.renderId).toBe("ren1");
    expect(rows[0]?.storageKey).toBe("exports/ren1.mp4");

    const row = rows[0];
    expect(row).toBeDefined();
    const parsed = JSON.parse(row?.auditJson ?? "") as { script: unknown; critic: unknown; ttsSettings: unknown; auditResult: unknown };
    expect(parsed.script).toEqual({ hook: "hook", body: "body", debateQuestion: "question?" });
    expect(parsed.ttsSettings).toEqual({ voice: "en-US-GuyNeural", rate: "+0%", pitch: "+0Hz", volume: "+0%" });

    await expect(readFile(renderFilePath)).rejects.toThrow();
  });

  it("leaves the local file untouched and writes no exports row when the KV store fails", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]) as Uint8Array<ArrayBuffer>;
    const result = await runExport(ctx.db, renderFilePath, bytes, packageInput("ren1"), { export: fakeExportDriver("fail") });

    expect(result.status).toBe("failed");
    expect(result.error?.kind).toBe("provider_error");
    expect(ctx.db.select().from(exportsTable).all()).toHaveLength(0);
    await expect(readFile(renderFilePath)).resolves.toBeDefined();
  });

  it("sets expiresAt to createdAt + the configured TTL (3 days by default)", async () => {
    const bytes = new Uint8Array([1]) as Uint8Array<ArrayBuffer>;
    await runExport(ctx.db, renderFilePath, bytes, packageInput("ren1"), { export: fakeExportDriver("succeed") });

    const row = ctx.db.select().from(exportsTable).all()[0];
    expect(row).toBeDefined();
    const deltaMs = new Date(row?.expiresAt ?? "").getTime() - new Date(row?.createdAt ?? "").getTime();
    expect(deltaMs).toBe(EXPORT_TTL_SECONDS * 1000);
  });

  it("assembleAuditJson round-trips every field a reviewer needs", () => {
    const json = assembleAuditJson(packageInput("ren1"));
    const parsed = JSON.parse(json);
    expect(parsed.critic.verdict).toBe("approved");
    expect(parsed.footage.segmentId).toBe("seg1");
    expect(parsed.auditResult.flags).toEqual([]);
  });

  it("records the narration settings that were actually used, including a driver that has no rate", async () => {
    // The audit package's one job is to be true. On the Gemini path this
    // block used to carry the Edge voice and rate the directive selected
    // before the driver was chosen, so it named a voice that never spoke
    // (observed in the first successful live run, 2026-09-01). Null reads as
    // "does not apply to this driver"; "+0%" would read as a chosen setting.
    const bytes = new Uint8Array([1, 2, 3, 4]) as Uint8Array<ArrayBuffer>;
    const input = { ...packageInput("ren1"), ttsSettings: { voice: "Kore", rate: null, pitch: null, volume: null } };

    await runExport(ctx.db, renderFilePath, bytes, input, { export: fakeExportDriver("succeed") });

    const rows = ctx.db.select().from(exportsTable).all();
    const parsed = JSON.parse(rows[0]?.auditJson ?? "") as { ttsSettings: unknown };
    expect(parsed.ttsSettings).toEqual({ voice: "Kore", rate: null, pitch: null, volume: null });
  });
});

describe("the review window", () => {
  it("is two days, whether or not the video is downloaded or reviewed", () => {
    // Operator direction 2026-09-01, shortened from three. The sweep that
    // enforces it runs from WATCH as well as RENDER (db/exports-reap.ts),
    // because a sweep that only ran at the top of a render made "two days"
    // mean "whenever you next make a video".
    expect(EXPORT_TTL_SECONDS).toBe(2 * 86_400);
  });
});
