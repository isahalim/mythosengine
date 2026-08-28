import type { DriverError, VectorDriver, VectorMatch, VectorQuery, VectorRecord } from "./types.ts";
import { err, type Result } from "../result.ts";

/**
 * NOT YET IMPLEMENTED. Real implementation is Phase 4 work — needs
 * node:sqlite + the sqlite-vec loadable extension, and only matters once
 * there's a corpus and an eval set to test recall against (Phase 4's
 * recall@8 ≥ 0.8 gate). An honest stub now beats an untested vector index.
 */
export class SqliteVecVectorDriver implements VectorDriver {
  async upsert(_records: VectorRecord[]): Promise<Result<{ count: number }, DriverError>> {
    return err({
      kind: "not_implemented",
      message: "SqliteVecVectorDriver is not implemented yet — see Phase 4 in AGENT_PLAYBOOK.md",
      retryable: false,
    });
  }

  async query(_query: VectorQuery): Promise<Result<VectorMatch[], DriverError>> {
    return err({
      kind: "not_implemented",
      message: "SqliteVecVectorDriver is not implemented yet — see Phase 4 in AGENT_PLAYBOOK.md",
      retryable: false,
    });
  }
}
