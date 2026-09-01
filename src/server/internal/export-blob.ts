import type { AppDb } from "../../../db/client.ts";
import { writeAuditLog } from "../audit.ts";
import { log } from "../log.ts";
import { checkSharedSecret } from "./shared-secret.ts";

/**
 * `PUT|DELETE /internal/exports/:key` — the pipeline's door to the export
 * blob store.
 *
 * **Why it exists.** Export blobs moved from KV to R2 on 2026-08-31, because
 * a 128s 1080x1920 render is ~42 MB and KV caps one value at 25 MiB. The
 * pipeline runs in GitHub Actions, which is plain Node with no Worker
 * bindings, and the Actions `CLOUDFLARE_API_TOKEN` deliberately has no R2
 * permission — so it cannot reach the bucket directly. The Worker holds the
 * binding, so the bytes come here, exactly the way `/internal/d1/batch`
 * already solves the same shape of problem for atomic writes. No new
 * credential enters the system to make this work.
 *
 * **What guards it.** The same `PIPELINE_BATCH_TOKEN` bearer, compared in
 * constant time and fail-closed when unset; a key format that cannot escape
 * the export namespace; a hard size ceiling; and an audit row per call.
 *
 * The body is **streamed** into R2 rather than buffered. A Worker has a
 * 128 MB memory ceiling and these are tens of megabytes each; reading one
 * into an ArrayBuffer to hand it straight to `.put()` would be the one
 * allocation big enough to matter.
 */

/**
 * The only key shape this endpoint will write.
 *
 * `exports/<uuid>.mp4` — not free text. The key is taken from the URL path,
 * so without this an authenticated caller could write anywhere in the
 * bucket, and a `..` or a leading slash would put the object somewhere the
 * download route would never look for it.
 *
 * The prefix also distinguishes storage backends: rows written before this
 * change carry a `export:<id>.mp4` KV key, and `src/server/console/exports.ts`
 * routes a download by which shape it sees. Old exports keep working.
 */
const EXPORT_KEY_PATTERN = /^exports\/[0-9a-fA-F-]{36}\.mp4$/;

/**
 * 512 MB. Not a quality target — a bound on what one authenticated call can
 * push into the bucket. The real ceiling on a render is the encoder's, and
 * a 180s Short is nowhere near this; anything that is has gone wrong
 * upstream and should be refused rather than stored.
 */
const MAX_BLOB_BYTES = 512 * 1024 * 1024;

export interface ExportBlobDeps {
  db: AppDb;
  /** The R2 binding. Undefined when the Worker was deployed without one — refused, never silently skipped. */
  exportBucket: R2Bucket | undefined;
  pipelineBatchToken: string | undefined;
}

export async function handleExportBlob(request: Request, key: string, deps: ExportBlobDeps): Promise<Response> {
  if (deps.pipelineBatchToken === undefined || deps.pipelineBatchToken.length === 0) {
    log.error({ event: "export_blob.unconfigured" }, "PIPELINE_BATCH_TOKEN is not set on this Worker — refusing every internal export write.");
  }
  const rejected = await checkSharedSecret(request, deps.pipelineBatchToken);
  if (rejected !== null) return rejected;

  if (!EXPORT_KEY_PATTERN.test(key)) {
    return Response.json({ error: "invalid_key", detail: "export keys look like exports/<render-uuid>.mp4" }, { status: 400 });
  }

  if (deps.exportBucket === undefined) {
    // A deployment with no R2 binding cannot store an export, and saying so
    // is the only honest answer. Falling back to KV would reintroduce the
    // 25 MiB ceiling this endpoint exists to escape.
    log.error({ event: "export_blob.no_binding" }, "This Worker has no EXPORTS R2 binding — refusing the export write.");
    return Response.json({ error: "not_configured", detail: "no EXPORTS R2 binding on this Worker" }, { status: 503 });
  }

  if (request.method === "DELETE") {
    await deps.exportBucket.delete(key);
    await writeAuditLog(deps.db, "pipeline", "export.blob_delete", key, {});
    log.info({ event: "export_blob.deleted", key }, "Export blob deleted.");
    return Response.json({ ok: true });
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > MAX_BLOB_BYTES) {
    return Response.json({ error: "too_large", detail: `exports are capped at ${MAX_BLOB_BYTES} bytes` }, { status: 413 });
  }
  if (request.body === null) {
    return Response.json({ error: "invalid_request", detail: "no request body" }, { status: 400 });
  }

  let stored: R2Object;
  try {
    stored = await deps.exportBucket.put(key, request.body, {
      httpMetadata: { contentType: request.headers.get("content-type") ?? "video/mp4" },
    });
  } catch (cause) {
    // The caller is a headless pipeline whose only evidence is a CI log, so
    // R2's own explanation goes back over the wire rather than being
    // flattened into "500" — the same reason /internal/d1/batch returns its
    // detail.
    const detail = cause instanceof Error ? cause.message : String(cause);
    log.error({ event: "export_blob.failed", key, detail }, "Export blob write failed.");
    return Response.json({ error: "store_failed", detail }, { status: 500 });
  }

  await writeAuditLog(deps.db, "pipeline", "export.blob_put", key, { sizeBytes: stored.size });
  log.info({ event: "export_blob.stored", key, sizeBytes: stored.size }, "Export blob stored.");
  return Response.json({ ok: true, key, sizeBytes: stored.size });
}
