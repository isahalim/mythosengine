import type { CacheDriver, DriverError } from "./types.ts";
import { ok, type Result } from "../result.ts";

interface Entry {
  value: string;
  expiresAt: number | null;
}

/** In-process cache driver. Used for local dev/tests; never durable. */
export class MemoryCacheDriver implements CacheDriver {
  private readonly store = new Map<string, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  async get(key: string): Promise<Result<string | null, DriverError>> {
    const entry = this.store.get(key);
    if (!entry) return ok(null);
    if (entry.expiresAt !== null && entry.expiresAt <= this.now()) {
      this.store.delete(key);
      return ok(null);
    }
    return ok(entry.value);
  }

  async put(key: string, value: string, ttlSeconds?: number): Promise<Result<void, DriverError>> {
    const expiresAt = ttlSeconds !== undefined ? this.now() + ttlSeconds * 1000 : null;
    this.store.set(key, { value, expiresAt });
    return ok(undefined);
  }
}
