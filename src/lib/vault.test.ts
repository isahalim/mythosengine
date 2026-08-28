import { describe, expect, it } from "vitest";
import { Vault, type VaultKv } from "./vault.ts";

class FakeKv implements VaultKv {
  readonly store = new Map<string, { value: string; expirationTtl?: number }>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key)?.value ?? null;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, { value, expirationTtl: options?.expirationTtl });
  }
}

const MASTER_KEY_B64 = "3q2-7_zdaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; // 32 zero-ish bytes, base64url, test-only

describe("Vault", () => {
  it("returns null for a name that was never rotated in", async () => {
    const vault = new Vault(new FakeKv(), MASTER_KEY_B64);
    const result = await vault.get("GROQ_API_KEY");
    expect(result).toEqual({ ok: true, value: null });
  });

  it("round-trips a rotated value through encrypt then decrypt", async () => {
    const vault = new Vault(new FakeKv(), MASTER_KEY_B64);
    const rotated = await vault.rotate("GROQ_API_KEY", "gsk_test_secret_value_1234567890");
    expect(rotated.ok).toBe(true);

    const read = await vault.get("GROQ_API_KEY");
    expect(read.ok).toBe(true);
    if (read.ok && read.value !== null) {
      expect(read.value.value).toBe("gsk_test_secret_value_1234567890");
      expect(read.value.version).toBe(1);
      expect(read.value.last4).toBe("7890");
    }
  });

  it("never stores the plaintext value anywhere in the underlying KV", async () => {
    const kv = new FakeKv();
    const vault = new Vault(kv, MASTER_KEY_B64);
    await vault.rotate("GROQ_API_KEY", "gsk_super_secret_do_not_leak");
    for (const [, entry] of kv.store) {
      expect(entry.value).not.toContain("gsk_super_secret_do_not_leak");
    }
  });

  it("moves the active pointer and keeps the previous version readable with a TTL after a second rotation", async () => {
    const kv = new FakeKv();
    const vault = new Vault(kv, MASTER_KEY_B64);
    await vault.rotate("GROQ_API_KEY", "first-value");
    await vault.rotate("GROQ_API_KEY", "second-value");

    const current = await vault.get("GROQ_API_KEY");
    expect(current.ok).toBe(true);
    if (current.ok && current.value !== null) {
      expect(current.value.value).toBe("second-value");
      expect(current.value.version).toBe(2);
    }

    const previousVersionEntry = kv.store.get("vault:GROQ_API_KEY:v1");
    expect(previousVersionEntry?.expirationTtl).toBe(24 * 60 * 60);
  });

  it("fails closed with a DriverError, not a thrown exception, on a corrupt stored payload", async () => {
    const kv = new FakeKv();
    const vault = new Vault(kv, MASTER_KEY_B64);
    await vault.rotate("GROQ_API_KEY", "value");
    await kv.put("vault:GROQ_API_KEY:v1", "not valid json");

    const result = await vault.get("GROQ_API_KEY");
    expect(result.ok).toBe(false);
  });

  it("scopes ciphertext to its key name via AAD — decrypting under a different name fails", async () => {
    const kv = new FakeKv();
    const vault = new Vault(kv, MASTER_KEY_B64);
    await vault.rotate("GROQ_API_KEY", "value");

    // Simulate replaying the same ciphertext under a different key name.
    const stolen = kv.store.get("vault:GROQ_API_KEY:v1");
    if (stolen) await kv.put("vault:YOUTUBE_API_KEY:v1", stolen.value);
    await kv.put("vault:YOUTUBE_API_KEY:current", "1");

    const result = await vault.get("YOUTUBE_API_KEY");
    expect(result.ok).toBe(false);
  });
});
