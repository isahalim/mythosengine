import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../../db/client.ts";
import { applyMigrations } from "../../../db/apply-migrations.ts";
import { exports as exportsTable, renders, scripts, signals, sources, footageSources, footageSegments } from "../../../db/schema.ts";
import { discardExport, downloadExport, getExport, getExportMetadata, listExports, markExportReviewed, parseByteRange, streamExport, type ExportBlobStore, exportFileName } from "./exports.ts";

class FakeBlobStore implements ExportBlobStore {
  readonly store = new Map<string, ArrayBuffer>();
  async get(key: string): Promise<ArrayBuffer | null> {
    return this.store.get(key) ?? null;
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

async function seedExport(
  db: ReturnType<typeof createTestDb>["db"],
  id: string,
  status: "ready_for_review" | "downloaded" | "reviewed" | "discarded" | "expired",
  storageKey = `blob:${id}`,
  overrides: { auditJson?: string; suggestedTagsJson?: string } = {},
) {
  await db.insert(sources).values({ id: "src1", kind: "reddit", url: "http://x" }).run();
  await db.insert(signals).values({ id: "sig1", sourceId: "src1", canonicalUrl: "http://x/1", title: "t", observedAt: "2026-01-01", engagementScore: 1, simhash: "a", state: "exported" }).run();
  await db.insert(scripts).values({ id: "scr1", signalId: "sig1", hook: "h", body: "b", debateQuestion: "q", wordCount: 10, status: "approved", createdAt: "2026-01-01" }).run();
  await db.insert(footageSources).values({ id: "fsrc1", channelUrl: "http://y", game: "minecraft", licenseNote: "owned" }).run();
  await db.insert(footageSegments).values({ id: "fseg1", footageSourceId: "fsrc1", sourceVideoId: "v1", clipStartS: 0, clipEndS: 10, motionScore: 1, libraryPath: "p", fetchedAt: "2026-01-01" }).run();
  await db.insert(renders).values({ id: "ren1", scriptId: "scr1", footageSegmentId: "fseg1", ttsDriver: "edge", ttsVoice: "v", status: "rendered", createdAt: "2026-01-01" }).run();
  await db
    .insert(exportsTable)
    .values({
      id,
      renderId: "ren1",
      storageKey,
      sizeBytes: 100,
      suggestedTitle: "title",
      suggestedDescription: "desc",
      suggestedTagsJson: overrides.suggestedTagsJson ?? "[]",
      auditJson: overrides.auditJson ?? "{}",
      createdAt: "2026-01-01",
      expiresAt: "2026-01-04",
      status,
    })
    .run();
}

describe("exports service", () => {
  let ctx: ReturnType<typeof createTestDb>;
  let blobs: FakeBlobStore;

  beforeEach(async () => {
    ctx = createTestDb();
    applyMigrations(ctx.client);
    blobs = new FakeBlobStore();
  });

  it("lists exports filtered by status", async () => {
    await seedExport(ctx.db, "exp1", "ready_for_review");
    const all = await listExports(ctx.db);
    expect(all).toHaveLength(1);
    const filtered = await listExports(ctx.db, "reviewed");
    expect(filtered).toHaveLength(0);
  });

  it("marks a ready-for-review export reviewed", async () => {
    await seedExport(ctx.db, "exp1", "ready_for_review");
    const result = await markExportReviewed(ctx.db, "exp1");
    expect(result).toEqual({ kind: "ok" });
    expect((await getExport(ctx.db, "exp1"))?.status).toBe("reviewed");
  });

  it("returns not_found for an unknown export id", async () => {
    expect(await markExportReviewed(ctx.db, "nope")).toEqual({ kind: "not_found" });
  });

  it("streams the real bytes from KV and marks a ready_for_review export downloaded", async () => {
    await seedExport(ctx.db, "exp1", "ready_for_review");
    blobs.store.set("blob:exp1", new TextEncoder().encode("fake mp4 bytes").buffer);

    const result = await downloadExport(ctx.db, { kv: blobs, r2: undefined }, "exp1");
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(await new Response(result.body).text()).toBe("fake mp4 bytes");
    expect((await getExport(ctx.db, "exp1"))?.status).toBe("downloaded");
  });

  it("reports blob_missing rather than fabricating bytes when the KV blob is gone", async () => {
    await seedExport(ctx.db, "exp1", "ready_for_review");
    const result = await downloadExport(ctx.db, { kv: blobs, r2: undefined }, "exp1");
    expect(result.kind).toBe("blob_missing");
  });

  it("discards an export and frees its KV blob before the TTL", async () => {
    await seedExport(ctx.db, "exp1", "ready_for_review");
    blobs.store.set("blob:exp1", new ArrayBuffer(10));
    const result = await discardExport(ctx.db, { kv: blobs, r2: undefined }, "exp1");
    expect(result).toEqual({ kind: "ok" });
    expect(blobs.store.has("blob:exp1")).toBe(false);
    expect((await getExport(ctx.db, "exp1"))?.status).toBe("discarded");
  });
});

/**
 * Export blobs moved from KV to R2 on 2026-08-31 (KV caps a value at 25 MiB;
 * a 128s render is ~42 MB). Rows written before that are still in the review
 * queue, so both backends have to work, and which one an export uses is read
 * off its storage key rather than assumed.
 */
class FakeObjectStore {
  readonly store = new Map<string, string>();
  /** Every get, ranged or not, so a test can assert the probe-then-read shape. */
  readonly reads: ({ offset: number; length: number } | null)[] = [];
  async get(key: string, options?: { range: { offset: number; length: number } }): Promise<{ body: ReadableStream; size: number } | null> {
    const value = this.store.get(key);
    if (value === undefined) return null;
    this.reads.push(options?.range ?? null);
    const bytes = new TextEncoder().encode(value);
    // R2 reports the FULL object size on a ranged read too, which is the
    // half of the contract Content-Range depends on.
    const slice = options === undefined ? bytes : bytes.slice(options.range.offset, options.range.offset + options.range.length);
    return { body: new Response(slice).body as ReadableStream, size: bytes.byteLength };
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

describe("export blobs, across the KV-to-R2 move", () => {
  let ctx: ReturnType<typeof createTestDb>;
  let kv: FakeBlobStore;
  let r2: FakeObjectStore;

  beforeEach(() => {
    ctx = createTestDb();
    applyMigrations(ctx.client);
    kv = new FakeBlobStore();
    r2 = new FakeObjectStore();
  });

  it("reads a new export from R2, by its key shape alone", async () => {
    await seedExport(ctx.db, "exp-r2", "ready_for_review", "exports/11111111-1111-1111-1111-111111111111.mp4");
    r2.store.set("exports/11111111-1111-1111-1111-111111111111.mp4", "r2 mp4 bytes");

    const result = await downloadExport(ctx.db, { kv, r2 }, "exp-r2");

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(await new Response(result.body).text()).toBe("r2 mp4 bytes");
  });

  it("still reads a legacy export from KV — the move backfilled nothing", async () => {
    await seedExport(ctx.db, "exp-kv", "ready_for_review", "export:legacy.mp4");
    kv.store.set("export:legacy.mp4", new TextEncoder().encode("kv mp4 bytes").buffer);

    const result = await downloadExport(ctx.db, { kv, r2 }, "exp-kv");

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(await new Response(result.body).text()).toBe("kv mp4 bytes");
  });

  it("frees the right store on discard, and only that one", async () => {
    await seedExport(ctx.db, "exp-r2", "ready_for_review", "exports/22222222-2222-2222-2222-222222222222.mp4");
    r2.store.set("exports/22222222-2222-2222-2222-222222222222.mp4", "bytes");
    kv.store.set("export:untouched.mp4", new ArrayBuffer(4));

    expect(await discardExport(ctx.db, { kv, r2 }, "exp-r2")).toEqual({ kind: "ok" });

    expect(r2.store.size).toBe(0);
    expect(kv.store.has("export:untouched.mp4")).toBe(true);
  });

  it("refuses rather than orphaning the object when the Worker has no R2 binding", async () => {
    await seedExport(ctx.db, "exp-r2", "ready_for_review", "exports/33333333-3333-3333-3333-333333333333.mp4");

    // Not "blob_missing": the blob may well exist. This deployment simply
    // cannot see it, and reporting that as a missing file would send the
    // operator looking for a lost render.
    expect((await downloadExport(ctx.db, { kv, r2: undefined }, "exp-r2")).kind).toBe("no_blob_store");
    expect(await discardExport(ctx.db, { kv, r2: undefined }, "exp-r2")).toEqual({ kind: "no_blob_store" });
    expect((await getExport(ctx.db, "exp-r2"))?.status).toBe("ready_for_review");
  });
});

describe("an export stays reachable after it is downloaded", () => {
  it("is listed under the status downloadExport moves it to", async () => {
    // downloadExport flips ready_for_review -> downloaded. The console has a
    // tab per status, so a status no tab lists is an export that has
    // silently vanished from the operator's view — which is what happened
    // until the "Downloaded" tab was added (2026-08-31). This is that
    // invariant, guarded where it can be tested.
    const ctx = createTestDb();
    applyMigrations(ctx.client);
    const blobs = new FakeBlobStore();
    await seedExport(ctx.db, "exp1", "ready_for_review");
    blobs.store.set("blob:exp1", new TextEncoder().encode("mp4!").buffer);

    expect((await listExports(ctx.db, "ready_for_review")).map((e) => e.id)).toContain("exp1");

    const result = await downloadExport(ctx.db, { kv: blobs, r2: undefined }, "exp1");
    expect(result.kind).toBe("ok");

    expect((await listExports(ctx.db, "ready_for_review")).map((e) => e.id)).not.toContain("exp1");
    expect((await listExports(ctx.db, "downloaded")).map((e) => e.id)).toContain("exp1");
  });
});

describe("exportFileName", () => {
  it("slugs the suggested title and always ends in the export id", () => {
    expect(exportFileName("Ever watched a movie so insane?", "exp1")).toBe("Ever-watched-a-movie-so-insane-exp1.mp4");
  });

  it("falls back to the id alone when the title slugs to nothing", () => {
    // Titles are model-generated; one made only of emoji or punctuation is
    // not hypothetical.
    expect(exportFileName("🎬🔥 —— !!", "exp1")).toBe("exp1.mp4");
    expect(exportFileName("", "exp1")).toBe("exp1.mp4");
  });

  it("cannot break out of the Content-Disposition header it is placed in", () => {
    const hostile = 'a"; filename="owned.exe\r\nX-Injected: yes';
    const name = exportFileName(hostile, "exp1");
    expect(name).not.toContain('"');
    expect(name).not.toMatch(/[\r\n]/);
    expect(name).toMatch(/^[A-Za-z0-9_-]+\.mp4$/);
  });

  it("bounds the length so a long title cannot produce an unusable filename", () => {
    expect(exportFileName("word ".repeat(200), "exp1").length).toBeLessThanOrEqual(80);
  });
});

describe("getExportMetadata", () => {
  let ctx: ReturnType<typeof createTestDb>;

  beforeEach(async () => {
    ctx = createTestDb();
    applyMigrations(ctx.client);
  });

  /** An audit package of the shape RENDER writes: two clips, one YouTube and one stock. */
  const AUDIT = JSON.stringify({
    script: { hook: "h", body: "b", debateQuestion: "q" },
    footage: {
      segmentId: "fseg1",
      parts: [
        {
          position: 0,
          segmentId: "yt-abc-2470",
          startMs: 0,
          endMs: 8_000,
          provider: "youtube",
          providerClipId: "abc",
          photographer: null,
          pageUrl: "https://www.youtube.com/watch?v=abc",
          searchQuery: "Iceland parliament voting session",
          beatIndex: 0,
          sourceStartS: 2470,
          sourceEndS: 2535,
        },
        {
          position: 1,
          segmentId: "pexels-99",
          startMs: 8_000,
          endMs: 14_500,
          provider: "pexels",
          providerClipId: "99",
          photographer: "A Photographer",
          pageUrl: "https://www.pexels.com/video/99/",
          searchQuery: "volcanic landscape",
          beatIndex: 1,
          sourceStartS: 0,
          sourceEndS: 12,
        },
      ],
    },
    auditResult: {
      narration: { driver: "gemini-tts", voice: "Kore", fallbackReason: null, captionTiming: "aligned" },
      ungrounded: false,
      research: { model: "openai/gpt-oss-120b", citations: [{ title: "A source", url: "https://example.com/a" }] },
      edit: {
        model: "qwen/qwen3.8-27b",
        degradedReason: null,
        clips: [
          { position: 0, edited: true, toolsRun: ["video_info", "video_detect_scenes", "video_trim"], skippedReason: null },
          { position: 1, edited: false, toolsRun: [], skippedReason: "the model judged the clip already right and changed nothing" },
        ],
      },
    },
  });

  it("answers 'which YouTube videos are in this, and which part of each'", async () => {
    await seedExport(ctx.db, "exp1", "ready_for_review", "exports/exp1.mp4", { auditJson: AUDIT, suggestedTagsJson: '["iceland politics","EU"]' });
    const metadata = await getExportMetadata(ctx.db, "exp1");

    expect(metadata).not.toBeNull();
    if (metadata === null) throw new Error("expected metadata");
    expect(metadata.usedYoutube).toBe(true);

    const [youtube, stock] = metadata.clips;
    // The span of the SOURCE, not of the output — the two are different
    // facts and the source one is what a provenance check needs.
    expect(youtube.sourceStartS).toBe(2470);
    expect(youtube.sourceEndS).toBe(2535);
    expect(youtube.outStartS).toBe(0);
    expect(youtube.outEndS).toBe(8);
    // And a link that opens the source at that second.
    expect(youtube.linkUrl).toBe("https://www.youtube.com/watch?v=abc&t=2470");
    expect(youtube.edited).toBe(true);
    expect(youtube.editToolsRun).toEqual(["video_info", "video_detect_scenes", "video_trim"]);

    // A stock page has no time index, so none is invented for it.
    expect(stock.linkUrl).toBe("https://www.pexels.com/video/99/");
    expect(stock.photographer).toBe("A Photographer");
  });

  // Operator direction, 2026-09-04: the sheet has to say which clips the
  // model actually cut through Kinocut MCP. The audit package has carried it
  // since EDIT was added; only the one-line footnote rendered it, and it did
  // not name the model or say why an untouched clip was untouched.
  it("says which clips the model cut through Kinocut, and which model cut them", async () => {
    await seedExport(ctx.db, "exp1", "ready_for_review", "exports/exp1.mp4", { auditJson: AUDIT });
    const metadata = await getExportMetadata(ctx.db, "exp1");

    expect(metadata?.editModel).toBe("qwen/qwen3.8-27b");
    expect(metadata?.editDegradedReason).toBeNull();
    // Cut, and left alone, are separate outcomes and each carries its own
    // evidence: the tools that ran, or the reason nothing did.
    expect(metadata?.clips[0].edited).toBe(true);
    expect(metadata?.clips[1].edited).toBe(false);
    expect(metadata?.clips[1].editSkippedReason).toContain("already right");
  });

  // The 2026-09-04 outage: both rungs refused every request, so the export
  // was a finished video with nothing trimmed. That is one stage-level fact,
  // not eight per-clip ones, and it was legible only in a Groq dashboard.
  it("reports a whole EDIT stage that never ran, separately from a clip left alone", async () => {
    const degraded = JSON.parse(AUDIT) as { auditResult: { edit: Record<string, unknown> } };
    degraded.auditResult.edit = {
      model: null,
      degradedReason: "Kinocut MCP server would not start (spawn uvx ENOENT) — every clip used unedited",
      clips: [
        { position: 0, edited: false, toolsRun: [], skippedReason: "Kinocut MCP server would not start" },
        { position: 1, edited: false, toolsRun: [], skippedReason: "Kinocut MCP server would not start" },
      ],
    };
    await seedExport(ctx.db, "exp1", "ready_for_review", "exports/exp1.mp4", { auditJson: JSON.stringify(degraded) });

    const metadata = await getExportMetadata(ctx.db, "exp1");
    expect(metadata?.editDegradedReason).toContain("would not start");
    expect(metadata?.editModel).toBeNull();
    expect(metadata?.clips.every((clip) => clip.edited === false)).toBe(true);
  });

  // An export from before EDIT existed carries no `edit` block at all, which
  // is not the same fact as "EDIT ran and changed nothing" — and a column
  // that rendered both as a dash would merge them.
  it("says an export predates EDIT rather than showing every clip as untouched", async () => {
    const old = JSON.parse(AUDIT) as { auditResult: Record<string, unknown> };
    delete old.auditResult.edit;
    await seedExport(ctx.db, "exp1", "ready_for_review", "exports/exp1.mp4", { auditJson: JSON.stringify(old) });

    const metadata = await getExportMetadata(ctx.db, "exp1");
    expect(metadata?.clips[0].edited).toBeNull();
    expect(metadata?.editModel).toBeNull();
    expect(metadata?.incomplete.join(" ")).toContain("predates the EDIT stage");
  });

  it("says plainly when nothing came from YouTube", async () => {
    const stockOnly = JSON.parse(AUDIT) as { footage: { parts: unknown[] } };
    stockOnly.footage.parts = [JSON.parse(AUDIT).footage.parts[1]];
    await seedExport(ctx.db, "exp1", "ready_for_review", "exports/exp1.mp4", { auditJson: JSON.stringify(stockOnly) });

    const metadata = await getExportMetadata(ctx.db, "exp1");
    expect(metadata?.usedYoutube).toBe(false);
  });

  it("turns the render's tags into hashtags a description box will accept", async () => {
    await seedExport(ctx.db, "exp1", "ready_for_review", "exports/exp1.mp4", { auditJson: AUDIT, suggestedTagsJson: '["iceland politics","EU vote!"]' });
    const metadata = await getExportMetadata(ctx.db, "exp1");
    expect(metadata?.hashtags).toEqual(["#icelandpolitics", "#EUvote"]);
  });

  it("says an export predates per-clip timestamps rather than showing it as starting at zero", async () => {
    const old = JSON.parse(AUDIT) as { footage: { parts: Record<string, unknown>[] } };
    for (const part of old.footage.parts) {
      delete part.sourceStartS;
      delete part.sourceEndS;
    }
    await seedExport(ctx.db, "exp1", "ready_for_review", "exports/exp1.mp4", { auditJson: JSON.stringify(old) });

    const metadata = await getExportMetadata(ctx.db, "exp1");
    expect(metadata?.clips[0].sourceStartS).toBeNull();
    expect(metadata?.clips[0].linkUrl).toBe("https://www.youtube.com/watch?v=abc");
    expect(metadata?.incomplete.join(" ")).toContain("predates per-clip source timestamps");
  });

  it("reports an unreadable audit package instead of throwing", async () => {
    await seedExport(ctx.db, "exp1", "ready_for_review", "exports/exp1.mp4", { auditJson: "{not json" });
    const metadata = await getExportMetadata(ctx.db, "exp1");
    expect(metadata?.clips).toEqual([]);
    expect(metadata?.incomplete.join(" ")).toContain("could not be read");
  });

  it("is null for an export that does not exist", async () => {
    expect(await getExportMetadata(ctx.db, "nope")).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/*  Playback.                                                          */
/*                                                                    */
/*  Stage 6's card plays the finished Short in place (operator         */
/*  direction 2026-09-03), which needs bytes that a browser will play  */
/*  rather than save, and ranges that a scrubber can seek with.        */
/* ------------------------------------------------------------------ */

describe("parseByteRange", () => {
  it("reads the three forms a media element actually sends", () => {
    expect(parseByteRange("bytes=0-", 100)).toEqual({ start: 0, end: 99 });
    expect(parseByteRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
    expect(parseByteRange("bytes=-20", 100)).toEqual({ start: 80, end: 99 });
  });

  it("clamps an end past the object rather than asking R2 for bytes that are not there", () => {
    expect(parseByteRange("bytes=90-500", 100)).toEqual({ start: 90, end: 99 });
  });

  it("serves the whole file for an absent or unsupported header instead of failing", () => {
    // Multipart ranges are legal HTTP that no browser asks a video source
    // for; answering 200 with everything is correct, just not partial.
    expect(parseByteRange(null, 100)).toBeNull();
    expect(parseByteRange("bytes=0-10,20-30", 100)).toBeNull();
    expect(parseByteRange("items=0-10", 100)).toBeNull();
    expect(parseByteRange("bytes=-", 100)).toBeNull();
  });

  it("is unsatisfiable only when the start is past the end of the object", () => {
    expect(parseByteRange("bytes=100-", 100)).toBe("unsatisfiable");
    expect(parseByteRange("bytes=-0", 100)).toBe("unsatisfiable");
    expect(parseByteRange("bytes=50-40", 100)).toBe("unsatisfiable");
    expect(parseByteRange("bytes=99-", 100)).toEqual({ start: 99, end: 99 });
  });
});

describe("streamExport", () => {
  let ctx: ReturnType<typeof createTestDb>;
  let kv: FakeBlobStore;
  let r2: FakeObjectStore;

  beforeEach(() => {
    ctx = createTestDb();
    applyMigrations(ctx.client);
    kv = new FakeBlobStore();
    r2 = new FakeObjectStore();
  });

  it("does NOT mark a ready_for_review export downloaded — watching is not keeping", async () => {
    await seedExport(ctx.db, "exp1", "ready_for_review", "exports/exp1.mp4");
    r2.store.set("exports/exp1.mp4", "0123456789");

    await streamExport(ctx.db, { kv, r2 }, "exp1", null);

    expect((await getExport(ctx.db, "exp1"))?.status).toBe("ready_for_review");
  });

  it("still marks it downloaded when the operator actually downloads it", async () => {
    await seedExport(ctx.db, "exp1", "ready_for_review", "exports/exp1.mp4");
    r2.store.set("exports/exp1.mp4", "0123456789");

    await downloadExport(ctx.db, { kv, r2 }, "exp1");

    expect((await getExport(ctx.db, "exp1"))?.status).toBe("downloaded");
  });

  it("serves a range out of R2 without reading the whole object", async () => {
    await seedExport(ctx.db, "exp1", "ready_for_review", "exports/exp1.mp4");
    r2.store.set("exports/exp1.mp4", "0123456789");

    const result = await streamExport(ctx.db, { kv, r2 }, "exp1", "bytes=3-6");

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(await new Response(result.body).text()).toBe("3456");
    expect(result.range).toEqual({ start: 3, end: 6 });
    // The full size, not the slice's — Content-Range reports the object.
    expect(result.size).toBe(10);
    // A one-byte probe to learn the size, then the range itself. Never the
    // whole object, which is the point of not buffering 40 MB in a Worker.
    expect(r2.reads).toEqual([{ offset: 0, length: 1 }, { offset: 3, length: 4 }]);
  });

  it("serves the whole object, unranged, when nothing asked for a range", async () => {
    await seedExport(ctx.db, "exp1", "ready_for_review", "exports/exp1.mp4");
    r2.store.set("exports/exp1.mp4", "0123456789");

    const result = await streamExport(ctx.db, { kv, r2 }, "exp1", null);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.range).toBeNull();
    expect(await new Response(result.body).text()).toBe("0123456789");
    expect(r2.reads).toEqual([null]);
  });

  it("ranges a legacy KV export by slicing it, since KV has no partial read", async () => {
    await seedExport(ctx.db, "exp-kv", "ready_for_review", "export:legacy.mp4");
    kv.store.set("export:legacy.mp4", new TextEncoder().encode("0123456789").buffer);

    const result = await streamExport(ctx.db, { kv, r2 }, "exp-kv", "bytes=2-4");

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(await new Response(result.body).text()).toBe("234");
    expect(result.size).toBe(10);
  });

  it("reports an out-of-bounds range with the size, so the caller can answer 416", async () => {
    await seedExport(ctx.db, "exp1", "ready_for_review", "exports/exp1.mp4");
    r2.store.set("exports/exp1.mp4", "0123456789");

    expect(await streamExport(ctx.db, { kv, r2 }, "exp1", "bytes=99-")).toEqual({ kind: "unsatisfiable", size: 10 });
  });

  it("distinguishes a missing row, a missing blob and a Worker with no bucket", async () => {
    expect((await streamExport(ctx.db, { kv, r2 }, "nope", null)).kind).toBe("not_found");

    await seedExport(ctx.db, "exp1", "ready_for_review", "exports/exp1.mp4");
    expect((await streamExport(ctx.db, { kv, r2 }, "exp1", null)).kind).toBe("blob_missing");
    expect((await streamExport(ctx.db, { kv, r2: undefined }, "exp1", null)).kind).toBe("no_blob_store");
  });
});
