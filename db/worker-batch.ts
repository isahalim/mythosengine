/**
 * `RawSqlClient`'s arm for code running outside the Worker — the GitHub
 * Actions pipeline — replacing `D1HttpRawClient`, which was deleted because
 * it could not work.
 *
 * The problem it solves: `execAtomic` needs statements that are both
 * parameterized and atomic. D1's REST `/query` endpoint offers exactly one
 * of those at a time — it answers `7400: The request is malformed: params
 * with multiple statements is not supported` to any attempt at both, and has
 * no equivalent of the Worker binding's `.batch()` (confirmed against the
 * live database 2026-08-31). The Worker *does* hold that binding, so the
 * batch is sent there and executed by the real primitive.
 *
 * Reads still go over the D1 REST API directly (`createD1HttpDb`) — they are
 * single statements and need no transaction. Only multi-statement writes
 * take this path, which keeps the authenticated surface as small as the job
 * requires.
 */
export interface WorkerBatchClientOptions {
  /** Base origin of the deployed Worker, e.g. `https://mythosengine.5ryfrrjgmg.workers.dev`. */
  workerUrl: string;
  /** Shared secret; must match the Worker's own `PIPELINE_BATCH_TOKEN`. Arrives from the environment and is never logged. */
  token: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class WorkerBatchClient {
  constructor(private readonly options: WorkerBatchClientOptions) {}

  async batch(statements: { sql: string; params: unknown[] }[]): Promise<void> {
    const endpoint = new URL("/internal/d1/batch", this.options.workerUrl);

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.options.token}` },
        body: JSON.stringify({ statements }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (cause) {
      throw new Error(`atomic batch could not reach the Worker at ${endpoint.origin}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    }

    if (!response.ok) {
      // The Worker sends back the database's own explanation; discarding it
      // here would recreate the exact failure mode this pipeline has been
      // bitten by three times — a broken run whose log cannot say why.
      // `.text()` rather than `.json()` because an error page from in front
      // of the Worker (a 502, an auth challenge) is not JSON, and the parse
      // failure would replace the evidence with a parser error.
      const detail = (await response.text().catch(() => "")).slice(0, 600);
      throw new Error(`atomic batch rejected by the Worker (HTTP ${response.status})${detail.length > 0 ? `: ${detail}` : ""}`);
    }
  }
}
