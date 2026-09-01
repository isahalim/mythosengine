import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../../db/client.ts";
import { applyMigrations } from "../../../db/apply-migrations.ts";
import { exports as exportsTable, renders, scripts, signals, sources, footageSources, footageSegments } from "../../../db/schema.ts";
import { discardExport, downloadExport, getExport, listExports, markExportReviewed, type ExportBlobStore, exportFileName } from "./exports.ts";

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
      suggestedTagsJson: "[]",
      auditJson: "{}",
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
  async get(key: string): Promise<{ body: ReadableStream } | null> {
    const value = this.store.get(key);
    if (value === undefined) return null;
    return { body: new Response(value).body as ReadableStream };
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
