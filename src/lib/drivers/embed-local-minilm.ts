import type { DriverError, EmbedDriver, EmbedRequest, EmbedResponse } from "./types.ts";
import { err, type Result } from "../result.ts";

/**
 * NOT YET IMPLEMENTED. Real implementation is Phase 4 work (multi-RAG
 * retrieval, ARCHITECTURE.md §5 stage 4): all-MiniLM-L6-v2 via
 * transformers.js, run once against a real recall@8 eval set so its
 * threshold means something. Wiring it now, untested against real
 * retrieval quality, would be worse than an honest stub — this always
 * returns a typed, non-retryable error rather than a fake embedding.
 */
export class LocalMinilmEmbedDriver implements EmbedDriver {
  async embed(_req: EmbedRequest): Promise<Result<EmbedResponse, DriverError>> {
    return err({
      kind: "not_implemented",
      message: "LocalMinilmEmbedDriver is not implemented yet — see Phase 4 in AGENT_PLAYBOOK.md",
      retryable: false,
    });
  }
}
