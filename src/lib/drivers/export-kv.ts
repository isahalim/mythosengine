import { fetchWithRetry } from "./http.ts";
import type { DriverError, ExportDriver, ExportStoreRequest, ExportStoreResponse } from "./types.ts";
import { err, ok, type Result } from "../result.ts";

/**
 * Writes a finished render + its audit package into Cloudflare KV via the
 * REST API (not a Workers binding — this runs from the GitHub Actions
 * pipeline runner, which is plain Node, not a Worker). 3-day TTL by
 * default (ARCHITECTURE.md §9) so the operator's manual-review window has
 * a bounded storage footprint.
 *
 * API shape confirmed against Cloudflare's current docs before writing this
 * (not guessed): PUT .../values/:key_name, multipart/form-data with a
 * `value` field, `expiration_ttl` query param (seconds, minimum 60),
 * `{ success, result, errors, messages }` response envelope. The exact
 * error shape for exceeding the documented 25 MiB per-value cap isn't
 * specified by Cloudflare's docs — this driver treats any `success: false`
 * response as a non-retryable `provider_error` rather than guessing a more
 * specific classification, and the real cap needs to be checked against a
 * real render's file size against a real namespace before this is wired
 * into a scheduled run (see docs/DECISIONS.md).
 */
export interface KvExportDriverOptions {
  accountId: string;
  namespaceId: string;
  apiToken: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
}

interface CloudflareApiEnvelope {
  success?: boolean;
  errors?: { code?: number; message?: string }[];
}

function isCloudflareApiEnvelope(value: unknown): value is CloudflareApiEnvelope {
  return typeof value === "object" && value !== null;
}

export class KvExportDriver implements ExportDriver {
  private readonly baseUrl: string;
  private readonly fetchImpl?: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;

  constructor(private readonly options: KvExportDriverOptions) {
    this.baseUrl = options.baseUrl ?? "https://api.cloudflare.com/client/v4";
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 500;
  }

  async store(req: ExportStoreRequest): Promise<Result<ExportStoreResponse, DriverError>> {
    if (req.ttlSeconds < 60) {
      return err({
        kind: "invalid_response",
        message: `ttlSeconds must be >= 60 (Cloudflare KV's minimum); got ${req.ttlSeconds}`,
        retryable: false,
      });
    }

    const url = `${this.baseUrl}/accounts/${this.options.accountId}/storage/kv/namespaces/${this.options.namespaceId}/values/${encodeURIComponent(req.key)}?expiration_ttl=${req.ttlSeconds}`;

    const form = new FormData();
    form.set("value", new Blob([req.bytes], { type: req.mimeType }), req.key);

    const result = await fetchWithRetry(
      url,
      {
        method: "PUT",
        headers: { authorization: `Bearer ${this.options.apiToken}` },
        body: form,
      },
      {
        timeoutMs: this.timeoutMs,
        maxAttempts: this.maxAttempts,
        baseDelayMs: this.baseDelayMs,
        fetchImpl: this.fetchImpl,
      },
    );

    if (!result.ok) return result;

    let body: unknown;
    try {
      body = await result.value.json();
    } catch (cause) {
      return err({
        kind: "invalid_response",
        message: `malformed JSON from Cloudflare KV API: ${cause instanceof Error ? cause.message : String(cause)}`,
        retryable: false,
      });
    }

    if (!isCloudflareApiEnvelope(body) || body.success !== true) {
      const errors = isCloudflareApiEnvelope(body) ? body.errors : undefined;
      const message = errors?.map((e) => `[${e.code ?? "?"}] ${e.message ?? "unknown error"}`).join("; ") || "Cloudflare KV write reported success: false";
      return err({ kind: "provider_error", message, retryable: false });
    }

    return ok({ key: req.key, sizeBytes: req.bytes.byteLength });
  }
}
