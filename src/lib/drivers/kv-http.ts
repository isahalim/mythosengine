import { fetchWithRetry } from "./http.ts";
import type { KvLike } from "./cache-kv.ts";

/**
 * Cloudflare KV over the REST API — same envelope/base URL KvExportDriver
 * already uses, the counterpart for reads (and small writes) instead of
 * blob storage. Exists so the GitHub Actions pipeline runner can check the
 * console's killswitch (`src/server/console/killswitch.ts`'s
 * `isPipelineEnabled`) before a scheduled run — without this, the
 * console's "halt everything immediately" button would only ever stop ad
 * hoc dispatches, never the actual scheduled cron.
 */
export interface KvHttpClientOptions {
  accountId: string;
  namespaceId: string;
  apiToken: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
}

export class KvHttpClient implements KvLike {
  private readonly baseUrl: string;

  constructor(private readonly options: KvHttpClientOptions) {
    this.baseUrl = options.baseUrl ?? "https://api.cloudflare.com/client/v4";
  }

  private retryOptions() {
    return {
      timeoutMs: this.options.timeoutMs ?? 15_000,
      maxAttempts: this.options.maxAttempts ?? 3,
      baseDelayMs: this.options.baseDelayMs ?? 500,
      fetchImpl: this.options.fetchImpl,
    };
  }

  /**
   * A 404 here means "key never set" — a valid, meaningful outcome (the
   * same way `fetchWithRetry` itself treats a conditional GET's 304 as
   * success rather than an error), which `fetchWithRetry`'s shared
   * retry/error classification has no way to express without changing that
   * behavior for every other caller. So this issues its own single
   * request/timeout rather than going through it — write path (`put`,
   * where any non-2xx is unambiguously a failure) still uses
   * `fetchWithRetry` below.
   */
  async get(key: string): Promise<string | null> {
    const url = `${this.baseUrl}/accounts/${this.options.accountId}/storage/kv/namespaces/${this.options.namespaceId}/values/${encodeURIComponent(key)}`;
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${this.options.apiToken}` },
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`KV HTTP GET failed: HTTP ${res.status} from ${url}`);
    return res.text();
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    const ttlParam = options?.expirationTtl !== undefined ? `?expiration_ttl=${options.expirationTtl}` : "";
    const url = `${this.baseUrl}/accounts/${this.options.accountId}/storage/kv/namespaces/${this.options.namespaceId}/values/${encodeURIComponent(key)}${ttlParam}`;

    const form = new FormData();
    form.set("value", value);

    const result = await fetchWithRetry(url, { method: "PUT", headers: { authorization: `Bearer ${this.options.apiToken}` }, body: form }, this.retryOptions());
    if (!result.ok) throw new Error(`KV HTTP PUT failed: [${result.error.kind}] ${result.error.message}`);

    let body: unknown;
    try {
      body = await result.value.json();
    } catch (cause) {
      throw new Error(`KV HTTP PUT response was not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    }
    const envelope = body as { success?: boolean; errors?: { code?: number; message?: string }[] };
    if (envelope.success !== true) {
      const message = envelope.errors?.map((e) => `[${e.code ?? "?"}] ${e.message ?? "unknown error"}`).join("; ") || "KV HTTP PUT reported success: false";
      throw new Error(message);
    }
  }
}
