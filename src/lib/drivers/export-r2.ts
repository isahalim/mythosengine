import { fetchWithRetry } from "./http.ts";
import type { DriverError, ExportDriver, ExportStoreRequest, ExportStoreResponse } from "./types.ts";
import { err, ok, type Result } from "../result.ts";

/**
 * Writes a finished render into R2, through the Worker.
 *
 * **Why through the Worker and not straight to R2.** This runs on the GitHub
 * Actions runner, which is plain Node with no Worker bindings, and the
 * Actions `CLOUDFLARE_API_TOKEN` has no R2 permission — deliberately, because
 * granting it would mean a new scope on a token that already reaches D1, KV
 * and the Worker script itself. The Worker holds the R2 binding, so the
 * bytes go to `PUT /internal/exports/:key` behind the `PIPELINE_BATCH_TOKEN`
 * shared secret that already exists for `/internal/d1/batch`. Nothing new is
 * provisioned to make this work.
 *
 * **Why it replaced KvExportDriver.** KV caps one value at 25 MiB. A 128s
 * 1080x1920 render is ~42 MB, so EXPORT died with `10024 content size of
 * 42225848 bytes exceeds maximum allowed size of 27MiB` *after* RESEARCH,
 * SCRIPT, CRITIC, FOOTAGE SELECT, TTS, ALIGN and a complete ffmpeg render
 * had all succeeded (2026-08-31, run 33471051464). Fitting a 180s Short into
 * one KV value would mean about 1.1 Mbps at 1080x1920.
 *
 * **The TTL is not the store's job any more.** KV expired a value by itself;
 * R2 has no per-object TTL, and this deployment's API token cannot set a
 * bucket lifecycle rule. So `ttlSeconds` still sets `exports.expires_at` —
 * which is what the review queue shows and filters on — and the blob is
 * actually removed by the sweep at the top of every RENDER
 * (`db/exports-reap.ts`). That is a real improvement on what KV gave us:
 * nothing ever set a row to `expired` before, so a row would outlive its
 * blob and the download would 410 with no explanation.
 */
export interface R2ExportDriverOptions {
  /** Base origin of the deployed Worker, e.g. `https://mythosengine.isahalim.workers.dev`. */
  workerUrl: string;
  /** Shared secret; must match the Worker's own `PIPELINE_BATCH_TOKEN`. Arrives from the environment and is never logged. */
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
}

interface StoreEnvelope {
  ok?: boolean;
  sizeBytes?: number;
}

/** The key an export's blob lives at. `exports/` distinguishes an R2 object from a legacy `export:<id>.mp4` KV value. */
export function r2ExportKey(renderId: string): string {
  return `exports/${renderId}.mp4`;
}

export class R2ExportDriver implements ExportDriver {
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;

  constructor(private readonly options: R2ExportDriverOptions) {
    // Generous: this is tens of megabytes leaving a laptop, not a JSON call.
    this.timeoutMs = options.timeoutMs ?? 180_000;
    // Retried, unlike a dispatch — an object PUT is idempotent on its key,
    // so a second attempt overwrites rather than duplicating.
    this.maxAttempts = options.maxAttempts ?? 2;
    this.baseDelayMs = options.baseDelayMs ?? 1_000;
  }

  keyFor(renderId: string): string {
    return r2ExportKey(renderId);
  }

  async store(req: ExportStoreRequest): Promise<Result<ExportStoreResponse, DriverError>> {
    const endpoint = new URL(`/internal/${req.key}`, this.options.workerUrl);

    const result = await fetchWithRetry(
      endpoint.toString(),
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${this.options.token}`,
          "content-type": req.mimeType,
          // Lets the Worker refuse an oversized blob before reading any of
          // it, rather than after streaming the whole thing.
          "content-length": String(req.bytes.byteLength),
        },
        body: req.bytes,
      },
      { timeoutMs: this.timeoutMs, maxAttempts: this.maxAttempts, baseDelayMs: this.baseDelayMs, fetchImpl: this.options.fetchImpl },
    );
    if (!result.ok) return result;

    let body: unknown;
    try {
      body = await result.value.json();
    } catch (cause) {
      return err({
        kind: "invalid_response",
        message: `malformed JSON from the Worker's export endpoint: ${cause instanceof Error ? cause.message : String(cause)}`,
        retryable: false,
      });
    }

    const envelope = body as StoreEnvelope | null;
    if (envelope?.ok !== true) {
      return err({ kind: "provider_error", message: `export write reported failure: ${JSON.stringify(body).slice(0, 300)}`, retryable: false });
    }

    // R2's own count of what it stored, not what we believed we sent — the
    // two differing is exactly the kind of silent truncation an export must
    // never carry into a review queue.
    const sizeBytes = envelope.sizeBytes ?? req.bytes.byteLength;
    if (sizeBytes !== req.bytes.byteLength) {
      return err({
        kind: "invalid_response",
        message: `stored ${sizeBytes} bytes but sent ${req.bytes.byteLength} — refusing to record a truncated export`,
        retryable: false,
      });
    }

    return ok({ key: req.key, sizeBytes });
  }

  /** Removes a blob whose row has expired or been discarded. Same door, same secret. */
  async remove(key: string): Promise<Result<void, DriverError>> {
    const endpoint = new URL(`/internal/${key}`, this.options.workerUrl);
    const result = await fetchWithRetry(
      endpoint.toString(),
      { method: "DELETE", headers: { authorization: `Bearer ${this.options.token}` } },
      { timeoutMs: 30_000, maxAttempts: 2, baseDelayMs: 500, fetchImpl: this.options.fetchImpl },
    );
    if (!result.ok) return result;
    return ok(undefined);
  }
}
