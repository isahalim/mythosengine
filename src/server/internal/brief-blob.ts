import type { AppDb } from "../../../db/client.ts";
import { writeAuditLog } from "../audit.ts";
import { log } from "../log.ts";
import { checkSharedSecret } from "./shared-secret.ts";

/**
 * `GET|DELETE /internal/briefs/:briefId/:position` — the pipeline's door to
 * one operator brief's attachments.
 *
 * **Why the direction is reversed from `/internal/exports/:key`.** That route
 * exists because the pipeline *writes* megabytes the Worker cannot produce.
 * This one exists because the pipeline *reads* bytes the Worker already has:
 * `POST /console/briefs` receives the multipart upload inside the Worker,
 * where the R2 binding lives, and puts the objects itself. The runner then
 * needs them for DIGEST, and — exactly as with export blobs — the Actions
 * `CLOUDFLARE_API_TOKEN` deliberately carries no R2 permission. So the bytes
 * come back out through the same `PIPELINE_BATCH_TOKEN` shared secret. No new
 * credential enters the system.
 *
 * **What guards it.** The same bearer, compared in constant time and
 * fail-closed when unset; a key shape that cannot escape the `briefs/`
 * namespace; and an audit row per call. It is deliberately *not* reachable
 * with a console session: an operator's browser has no reason to re-download
 * an attachment it just uploaded, and every route that needs no audience
 * should have none.
 */

/**
 * The only key shape this endpoint will read.
 *
 * `briefs/<uuid>/<n>` — matching `briefAttachmentKey` in db/briefs.ts, and
 * not free text. The key is taken from the URL path, so without this an
 * authenticated caller could read anywhere in the bucket, including every
 * export blob in it.
 */
const BRIEF_KEY_PATTERN = /^briefs\/[0-9a-fA-F-]{36}\/([0-9]|[1-9][0-9])$/;

export interface BriefBlobDeps {
  db: AppDb;
  /** The R2 binding. Undefined when the Worker was deployed without one — refused, never silently skipped. */
  exportBucket: R2Bucket | undefined;
  pipelineBatchToken: string | undefined;
}

export async function handleBriefBlob(request: Request, key: string, deps: BriefBlobDeps): Promise<Response> {
  if (deps.pipelineBatchToken === undefined || deps.pipelineBatchToken.length === 0) {
    log.error({ event: "brief_blob.unconfigured" }, "PIPELINE_BATCH_TOKEN is not set on this Worker — refusing every internal brief read.");
  }
  const rejected = await checkSharedSecret(request, deps.pipelineBatchToken);
  if (rejected !== null) return rejected;

  if (!BRIEF_KEY_PATTERN.test(key)) {
    return Response.json({ error: "invalid_key", detail: "brief attachment keys look like briefs/<brief-uuid>/<position>" }, { status: 400 });
  }

  if (deps.exportBucket === undefined) {
    log.error({ event: "brief_blob.no_binding" }, "This Worker has no EXPORTS R2 binding — refusing the brief attachment read.");
    return Response.json({ error: "not_configured", detail: "no EXPORTS R2 binding on this Worker" }, { status: 503 });
  }

  if (request.method === "DELETE") {
    await deps.exportBucket.delete(key);
    await writeAuditLog(deps.db, "pipeline", "brief.blob_delete", key, {});
    return Response.json({ ok: true });
  }

  const object = await deps.exportBucket.get(key);
  if (object === null) {
    // A real state, not an error: the brief may have been reaped, or the
    // upload may have failed after its row was written. The pipeline treats
    // it as "this attachment could not be read" and digests without it.
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  await writeAuditLog(deps.db, "pipeline", "brief.blob_get", key, { sizeBytes: object.size });
  // Streamed, not buffered — the same 128 MB Worker memory ceiling that
  // decided the export write's shape decides this one's.
  return new Response(object.body, {
    headers: {
      "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "content-length": String(object.size),
    },
  });
}
