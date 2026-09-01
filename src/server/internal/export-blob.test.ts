import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../../db/client.ts";
import { applyMigrations } from "../../../db/apply-migrations.ts";
import { auditLog } from "../../../db/schema.ts";
import { handleExportBlob } from "./export-blob.ts";

const TOKEN = "pipeline-token";
const KEY = "exports/11111111-1111-1111-1111-111111111111.mp4";

class FakeBucket {
  readonly objects = new Map<string, string>();
  async put(key: string, body: ReadableStream | ArrayBuffer | string): Promise<{ size: number }> {
    const text = body instanceof ReadableStream ? await new Response(body).text() : String(body);
    this.objects.set(key, text);
    return { size: new TextEncoder().encode(text).byteLength };
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

function put(key: string, body: string, token: string | null = TOKEN, extraHeaders: Record<string, string> = {}): Request {
  return new Request(`https://w.example/internal/${key}`, {
    method: "PUT",
    headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), "content-type": "video/mp4", ...extraHeaders },
    body,
  });
}

describe("PUT/DELETE /internal/exports/:key", () => {
  let ctx: ReturnType<typeof createTestDb>;
  let bucket: FakeBucket;

  beforeEach(() => {
    ctx = createTestDb();
    applyMigrations(ctx.client);
    bucket = new FakeBucket();
  });

  const deps = () => ({ db: ctx.db, exportBucket: bucket as unknown as R2Bucket, pipelineBatchToken: TOKEN });

  it("streams the blob into R2 and records an audit row", async () => {
    const response = await handleExportBlob(put(KEY, "mp4 bytes"), KEY, deps());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, key: KEY, sizeBytes: 9 });
    expect(bucket.objects.get(KEY)).toBe("mp4 bytes");

    const audit = await ctx.db.select().from(auditLog).all();
    expect(audit.map((row) => row.action)).toContain("export.blob_put");
  });

  it("fails closed when the shared secret is unset — an unconfigured deployment must not accept anonymous writes", async () => {
    const response = await handleExportBlob(put(KEY, "x"), KEY, { db: ctx.db, exportBucket: bucket as unknown as R2Bucket, pipelineBatchToken: undefined });

    expect(response.status).toBe(503);
    expect(bucket.objects.size).toBe(0);
  });

  it("rejects a missing or wrong bearer token", async () => {
    expect((await handleExportBlob(put(KEY, "x", null), KEY, deps())).status).toBe(401);
    expect((await handleExportBlob(put(KEY, "x", "wrong"), KEY, deps())).status).toBe(401);
    expect(bucket.objects.size).toBe(0);
  });

  it("refuses a key that could write outside the export namespace", async () => {
    // The key comes from the URL path, so an authenticated caller must not be
    // able to steer it anywhere in the bucket.
    for (const bad of ["exports/../secret.mp4", "other/thing.mp4", "exports/not-a-uuid.mp4", "exports/11111111-1111-1111-1111-111111111111.exe"]) {
      const response = await handleExportBlob(put(bad, "x"), bad, deps());
      expect(response.status, bad).toBe(400);
    }
    expect(bucket.objects.size).toBe(0);
  });

  it("refuses an oversized blob before reading it, on the declared length", async () => {
    const response = await handleExportBlob(put(KEY, "x", TOKEN, { "content-length": String(600 * 1024 * 1024) }), KEY, deps());

    expect(response.status).toBe(413);
    expect(bucket.objects.size).toBe(0);
  });

  it("says so when the Worker has no R2 binding rather than falling back to KV", async () => {
    // Falling back would restore the 25 MiB ceiling this endpoint exists to
    // escape, and would do it silently.
    const response = await handleExportBlob(put(KEY, "x"), KEY, { db: ctx.db, exportBucket: undefined, pipelineBatchToken: TOKEN });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "not_configured" });
  });

  it("deletes a blob and records that too", async () => {
    bucket.objects.set(KEY, "bytes");
    const request = new Request(`https://w.example/internal/${KEY}`, { method: "DELETE", headers: { authorization: `Bearer ${TOKEN}` } });

    const response = await handleExportBlob(request, KEY, deps());

    expect(response.status).toBe(200);
    expect(bucket.objects.size).toBe(0);
    expect((await ctx.db.select().from(auditLog).all()).map((row) => row.action)).toContain("export.blob_delete");
  });
});
