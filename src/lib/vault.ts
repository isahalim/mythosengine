import { err, ok, type Result } from "./result.ts";
import type { DriverError } from "./drivers/types.ts";

/**
 * The slice of Cloudflare's KVNamespace binding the vault needs. Same shape
 * as src/lib/drivers/cache-kv.ts's KvLike, kept as a separate type here so
 * the vault has no dependency on the cache driver.
 */
export interface VaultKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface VaultEntry {
  value: string;
  version: number;
  fingerprint: string;
  last4: string;
}

const PREVIOUS_VERSION_RETENTION_SECONDS = 24 * 60 * 60;

function currentPointerKey(name: string): string {
  return `vault:${name}:current`;
}

function versionKey(name: string, version: number): string {
  return `vault:${name}:v${version}`;
}

function toBase64Url(bytes: Uint8Array<ArrayBuffer>): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function fingerprintOf(plaintext: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(plaintext));
  return toBase64Url(new Uint8Array(digest)).slice(0, 12);
}

function aadFor(name: string, version: number): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${name}:v${version}`);
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

interface StoredPayload {
  iv: string;
  ciphertext: string;
  fingerprint: string;
  last4: string;
}

export interface VaultMetadata {
  version: number;
  fingerprint: string;
  last4: string;
}

/**
 * KV-backed encrypted key vault (CONSOLE_SPEC.md §2). AES-GCM, 96-bit random
 * IV, AAD binds the ciphertext to its key name + version so a version can't
 * be silently replayed under a different name. `get()` is the only method
 * that ever returns a decrypted value — CLAUDE.md's NEVER block requires
 * every call site of it to live in src/lib/drivers/** (see
 * src/lib/drivers/resolve-groq-driver.ts for the one production call site);
 * route/service code only ever calls `rotate()`, never `get()`.
 */
export class Vault {
  constructor(
    private readonly kv: VaultKv,
    private readonly masterKeyB64: string,
  ) {}

  private async importKey(): Promise<CryptoKey> {
    const raw = fromBase64Url(this.masterKeyB64);
    return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  }

  private async currentVersion(name: string): Promise<number | null> {
    const raw = await this.kv.get(currentPointerKey(name));
    if (raw === null) return null;
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }

  /**
   * Returns display metadata (fingerprint, last4, version) for `name`
   * *without* decrypting anything — safe to call from console routes
   * (CONSOLE_SPEC.md §2's key rows are built from exactly this), unlike
   * `get()`, whose decrypted value is restricted to src/lib/drivers/**.
   */
  async getMetadata(name: string): Promise<VaultMetadata | null> {
    const version = await this.currentVersion(name);
    if (version === null) return null;
    const raw = await this.kv.get(versionKey(name, version));
    if (raw === null) return null;
    const payload = JSON.parse(raw) as StoredPayload;
    return { version, fingerprint: payload.fingerprint, last4: payload.last4 };
  }

  /** Decrypts and returns the active version of `name`, or null if never rotated in. */
  async get(name: string): Promise<Result<VaultEntry | null, DriverError>> {
    try {
      const version = await this.currentVersion(name);
      if (version === null) return ok(null);

      const raw = await this.kv.get(versionKey(name, version));
      if (raw === null) return ok(null);

      const payload = JSON.parse(raw) as StoredPayload;
      const key = await this.importKey();
      const plaintextBytes = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromBase64Url(payload.iv), additionalData: aadFor(name, version) },
        key,
        fromBase64Url(payload.ciphertext),
      );
      const value = new TextDecoder().decode(plaintextBytes);
      return ok({ value, version, fingerprint: payload.fingerprint, last4: payload.last4 });
    } catch (cause) {
      return err({
        kind: "network",
        message: cause instanceof Error ? cause.message : String(cause),
        retryable: true,
      });
    }
  }

  /**
   * Encrypts `plaintext` as a new version and atomically flips the active
   * pointer to it. Callers (CONSOLE_SPEC.md §2's rotation flow) are
   * responsible for live-checking the candidate value against its provider
   * *before* calling this — rotate() never validates, it only stores.
   * The previous version, if any, is kept readable for
   * PREVIOUS_VERSION_RETENTION_SECONDS (instant-rollback window) via KV's
   * own TTL rather than a separate cleanup job.
   */
  async rotate(name: string, plaintext: string): Promise<Result<VaultEntry, DriverError>> {
    try {
      const previousVersion = await this.currentVersion(name);
      const nextVersion = (previousVersion ?? 0) + 1;

      const key = await this.importKey();
      const iv = randomBytes(12);
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aadFor(name, nextVersion) },
        key,
        new TextEncoder().encode(plaintext),
      );
      const fingerprint = await fingerprintOf(plaintext);
      const last4 = plaintext.slice(-4);

      const payload: StoredPayload = {
        iv: toBase64Url(iv),
        ciphertext: toBase64Url(new Uint8Array(ciphertext)),
        fingerprint,
        last4,
      };

      await this.kv.put(versionKey(name, nextVersion), JSON.stringify(payload));
      await this.kv.put(currentPointerKey(name), String(nextVersion));

      if (previousVersion !== null) {
        // Re-put the previous version's own payload with a TTL so it stays
        // readable for a rollback window instead of disappearing instantly.
        const previousRaw = await this.kv.get(versionKey(name, previousVersion));
        if (previousRaw !== null) {
          await this.kv.put(versionKey(name, previousVersion), previousRaw, {
            expirationTtl: PREVIOUS_VERSION_RETENTION_SECONDS,
          });
        }
      }

      return ok({ value: plaintext, version: nextVersion, fingerprint, last4 });
    } catch (cause) {
      return err({
        kind: "network",
        message: cause instanceof Error ? cause.message : String(cause),
        retryable: true,
      });
    }
  }
}
