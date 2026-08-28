import { describe, expect, it } from "vitest";
import type { CacheDriver } from "./types.ts";
import { MemoryCacheDriver } from "./cache-memory.ts";
import { KvCacheDriver, type KvLike } from "./cache-kv.ts";

class FakeKv implements KvLike {
  private readonly store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
}

function contractSuite(name: string, makeDriver: (now: () => number) => CacheDriver) {
  describe(`cache contract: ${name}`, () => {
    it("returns null for a missing key", async () => {
      const driver = makeDriver(Date.now);
      const result = await driver.get("missing");
      expect(result).toEqual({ ok: true, value: null });
    });

    it("round-trips a value with no TTL", async () => {
      const driver = makeDriver(Date.now);
      await driver.put("k", "v1");
      const result = await driver.get("k");
      expect(result).toEqual({ ok: true, value: "v1" });
    });

    it("overwrites an existing value", async () => {
      const driver = makeDriver(Date.now);
      await driver.put("k", "v1");
      await driver.put("k", "v2");
      const result = await driver.get("k");
      expect(result).toEqual({ ok: true, value: "v2" });
    });
  });
}

contractSuite("MemoryCacheDriver", (now) => new MemoryCacheDriver(now));
contractSuite("KvCacheDriver", () => new KvCacheDriver(new FakeKv()));

describe("KvCacheDriver error handling", () => {
  class ThrowingKv implements KvLike {
    async get(): Promise<string | null> {
      throw new Error("kv unavailable");
    }
    async put(): Promise<void> {
      throw new Error("kv unavailable");
    }
  }

  it("wraps a get() throw in a retryable DriverError instead of throwing", async () => {
    const driver = new KvCacheDriver(new ThrowingKv());
    const result = await driver.get("k");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("network");
      expect(result.error.retryable).toBe(true);
    }
  });

  it("wraps a put() throw in a retryable DriverError instead of throwing", async () => {
    const driver = new KvCacheDriver(new ThrowingKv());
    const result = await driver.put("k", "v");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("network");
  });

  class ThrowingNonErrorKv implements KvLike {
    async get(): Promise<string | null> {
      throw "kv unavailable";
    }
    async put(): Promise<void> {
      throw "kv unavailable";
    }
  }

  it("stringifies a thrown non-Error value rather than assuming .message exists", async () => {
    const driver = new KvCacheDriver(new ThrowingNonErrorKv());
    const result = await driver.get("k");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe("kv unavailable");
  });
});

describe("KvCacheDriver TTL forwarding", () => {
  it("forwards expirationTtl to the underlying namespace", async () => {
    let receivedOptions: { expirationTtl?: number } | undefined;
    class RecordingKv implements KvLike {
      async get(): Promise<string | null> {
        return null;
      }
      async put(_key: string, _value: string, options?: { expirationTtl?: number }): Promise<void> {
        receivedOptions = options;
      }
    }
    const driver = new KvCacheDriver(new RecordingKv());
    await driver.put("k", "v", 120);
    expect(receivedOptions).toEqual({ expirationTtl: 120 });
  });
});

describe("MemoryCacheDriver TTL", () => {
  it("expires a key after its TTL elapses", async () => {
    let now = 0;
    const driver = new MemoryCacheDriver(() => now);
    await driver.put("k", "v1", 10); // 10s TTL
    now += 11_000;
    const result = await driver.get("k");
    expect(result).toEqual({ ok: true, value: null });
  });

  it("does not expire before the TTL elapses", async () => {
    let now = 0;
    const driver = new MemoryCacheDriver(() => now);
    await driver.put("k", "v1", 10);
    now += 5_000;
    const result = await driver.get("k");
    expect(result).toEqual({ ok: true, value: "v1" });
  });
});
