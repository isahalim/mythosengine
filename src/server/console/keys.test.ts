import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rotateProviderKey } from "./keys.ts";

class FakeKv {
  private readonly store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
}

const MASTER_KEY_B64 = "3q2-7_zdaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("rotateProviderKey", () => {
  let server: Server;
  let baseUrl: string;
  let statusToReturn: number;

  beforeEach(async () => {
    statusToReturn = 200;
    server = createServer((_req, res) => {
      res.writeHead(statusToReturn, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }], items: [{ id: "x" }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected network address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(() => {
    server.close();
  });

  it("rejects a Groq key with the wrong shape before ever making a network call", async () => {
    let called = false;
    const fetchImpl: typeof fetch = async (...args) => {
      called = true;
      return fetch(...args);
    };
    const result = await rotateProviderKey(new FakeKv(), MASTER_KEY_B64, "GROQ_API_KEY", "not-a-real-key", fetchImpl);
    expect(result.kind).toBe("invalid_shape");
    expect(called).toBe(false);
  });

  it("writes nothing to the vault when the live check fails", async () => {
    statusToReturn = 401;
    const kv = new FakeKv();
    const fetchImpl: typeof fetch = (_url, init) => fetch(baseUrl, init as RequestInit);
    const result = await rotateProviderKey(kv, MASTER_KEY_B64, "GROQ_API_KEY", "gsk_" + "a".repeat(40), fetchImpl);
    expect(result.kind).toBe("live_check_failed");
    expect(await kv.get("vault:GROQ_API_KEY:current")).toBeNull();
  });

  it("rotates in a well-formed key once the live check succeeds", async () => {
    const kv = new FakeKv();
    const fetchImpl: typeof fetch = (_url, init) => fetch(baseUrl, init as RequestInit);
    const candidate = "gsk_" + "a".repeat(40);
    const result = await rotateProviderKey(kv, MASTER_KEY_B64, "GROQ_API_KEY", candidate, fetchImpl);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.last4).toBe(candidate.slice(-4));
      expect(result.activeVersion).toBe(1);
    }
    expect(await kv.get("vault:GROQ_API_KEY:current")).toBe("1");
  });
});
