import type { CacheDriver, DriverError } from "./types.ts";
import { err, ok, type Result } from "../result.ts";

/** The slice of Cloudflare's KVNamespace binding this driver actually uses. */
export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

/** Cloudflare KV cache driver. Hot JSON only — never blobs (ARCHITECTURE.md §0). */
export class KvCacheDriver implements CacheDriver {
  constructor(private readonly namespace: KvLike) {}

  async get(key: string): Promise<Result<string | null, DriverError>> {
    try {
      const value = await this.namespace.get(key);
      return ok(value);
    } catch (cause) {
      return err({
        kind: "network",
        message: cause instanceof Error ? cause.message : String(cause),
        retryable: true,
      });
    }
  }

  async put(key: string, value: string, ttlSeconds?: number): Promise<Result<void, DriverError>> {
    try {
      await this.namespace.put(key, value, ttlSeconds !== undefined ? { expirationTtl: ttlSeconds } : undefined);
      return ok(undefined);
    } catch (cause) {
      return err({
        kind: "network",
        message: cause instanceof Error ? cause.message : String(cause),
        retryable: true,
      });
    }
  }
}
