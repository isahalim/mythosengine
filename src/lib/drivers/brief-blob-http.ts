import { fetchWithRetry } from "./http.ts";
import { err, ok, type Result } from "../result.ts";
import type { DriverError } from "./types.ts";

/**
 * Reads one operator brief's attachments back out of R2, through the Worker.
 *
 * The mirror of `R2ExportDriver`, and it exists for exactly the same reason
 * that one does: this runs on the GitHub Actions runner, which has no Worker
 * bindings, and the Actions `CLOUDFLARE_API_TOKEN` deliberately carries no R2
 * permission. The Worker holds the binding, so the bytes come back through
 * `GET /internal/briefs/:briefId/:position` behind the `PIPELINE_BATCH_TOKEN`
 * shared secret that already exists. No new credential.
 *
 * The direction is reversed, though: exports are bytes the pipeline *makes*,
 * attachments are bytes the console *received*. `POST /console/briefs` put
 * them in the bucket itself, inside the Worker, where the binding is.
 *
 * **A failure here is never fatal.** DIGEST reads attachments to classify
 * better; it classifies without them if it has to, and the operator's own
 * prompt — the thing that actually decides the video — is in the database,
 * not in R2.
 */
export interface BriefBlobDriverOptions {
  /** Base origin of the deployed Worker. */
  workerUrl: string;
  /** Shared secret; must match the Worker's own `PIPELINE_BATCH_TOKEN`. Arrives from the environment and is never logged. */
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
}

export class BriefBlobDriver {
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;

  constructor(private readonly options: BriefBlobDriverOptions) {
    // Modest: an attachment is capped at a few megabytes by
    // `MAX_BRIEF_ATTACHMENT_BYTES`, not the tens an export is.
    this.timeoutMs = options.timeoutMs ?? 30_000;
    // Retried, because a GET is idempotent and this is one hop over the
    // public internet on a laptop's connection.
    this.maxAttempts = options.maxAttempts ?? 2;
  }

  async fetchAttachment(briefId: string, position: number): Promise<Result<Uint8Array<ArrayBuffer>, DriverError>> {
    const endpoint = new URL(`/internal/briefs/${briefId}/${position}`, this.options.workerUrl);
    const result = await fetchWithRetry(
      endpoint.toString(),
      { method: "GET", headers: { authorization: `Bearer ${this.options.token}` } },
      { timeoutMs: this.timeoutMs, maxAttempts: this.maxAttempts, baseDelayMs: 500 },
    );
    if (!result.ok) return err(result.error);

    try {
      return ok(new Uint8Array(await result.value.arrayBuffer()));
    } catch (cause) {
      return err({ kind: "network", message: `brief attachment ${briefId}/${position} could not be read: ${cause instanceof Error ? cause.message : String(cause)}`, retryable: false });
    }
  }
}
