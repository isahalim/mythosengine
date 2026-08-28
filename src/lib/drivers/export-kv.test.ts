import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KvExportDriver } from "./export-kv.ts";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

function startMockServer(): { server: Server; baseUrl: Promise<string>; routes: Map<string, Handler> } {
  const routes = new Map<string, Handler>();
  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    const handler = routes.get(path ?? "");
    if (!handler) {
      res.writeHead(404);
      res.end();
      return;
    }
    handler(req, res);
  });
  const baseUrl = new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("expected a network address");
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
  return { server, baseUrl, routes };
}

function jsonHandler(status: number, body: unknown): Handler {
  return (_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
}

const VALUE_PATH = "/accounts/acct1/storage/kv/namespaces/ns1/values/export%3Arender-1.mp4";

describe("KvExportDriver", () => {
  let mock: ReturnType<typeof startMockServer>;

  beforeEach(() => {
    mock = startMockServer();
  });

  afterEach(() => {
    mock.server.close();
  });

  async function makeDriver() {
    return new KvExportDriver({
      accountId: "acct1",
      namespaceId: "ns1",
      apiToken: "test-token",
      baseUrl: await mock.baseUrl,
      maxAttempts: 1,
    });
  }

  it("stores a value and returns the key + byte size on success", async () => {
    let receivedQuery = "";
    let receivedAuth = "";
    mock.routes.set(VALUE_PATH, (req, res) => {
      receivedQuery = req.url ?? "";
      receivedAuth = req.headers.authorization ?? "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: true, result: {}, errors: [], messages: [] }));
    });

    const driver = await makeDriver();
    const bytes = new Uint8Array([1, 2, 3, 4]) as Uint8Array<ArrayBuffer>;
    const result = await driver.store({
      key: "export:render-1.mp4",
      bytes,
      mimeType: "video/mp4",
      ttlSeconds: 3 * 86_400,
    });

    expect(result).toEqual({ ok: true, value: { key: "export:render-1.mp4", sizeBytes: 4 } });
    expect(receivedQuery).toContain("expiration_ttl=259200");
    expect(receivedAuth).toBe("Bearer test-token");
  });

  it("refuses a TTL below Cloudflare KV's 60-second minimum without making a request", async () => {
    const driver = await makeDriver();
    const bytes = new Uint8Array([1]) as Uint8Array<ArrayBuffer>;
    const result = await driver.store({ key: "export:x", bytes, mimeType: "video/mp4", ttlSeconds: 30 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("invalid_response");
      expect(result.error.retryable).toBe(false);
    }
  });

  it("fails cleanly, non-retryable, on an auth failure — a non-2xx short-circuits at the shared HTTP layer (http.ts), same as every other driver", async () => {
    mock.routes.set(
      VALUE_PATH,
      jsonHandler(401, { success: false, errors: [{ code: 10000, message: "Authentication error" }], messages: [] }),
    );

    const driver = await makeDriver();
    const bytes = new Uint8Array([1]) as Uint8Array<ArrayBuffer>;
    const result = await driver.store({ key: "export:render-1.mp4", bytes, mimeType: "video/mp4", ttlSeconds: 60 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("provider_error");
      expect(result.error.retryable).toBe(false);
      expect(result.error.message).toContain("HTTP 401");
    }
  });

  it("fails cleanly, non-retryable, when the API returns HTTP 200 with success: false in the body (Cloudflare's documented envelope shape)", async () => {
    mock.routes.set(VALUE_PATH, jsonHandler(200, { success: false, errors: [{ code: 10009, message: "value too large" }] }));

    const driver = await makeDriver();
    const bytes = new Uint8Array(30) as Uint8Array<ArrayBuffer>;
    const result = await driver.store({ key: "export:render-1.mp4", bytes, mimeType: "video/mp4", ttlSeconds: 60 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("provider_error");
      expect(result.error.retryable).toBe(false);
      expect(result.error.message).toContain("value too large");
    }
  });

  it("fails cleanly on malformed JSON in the response", async () => {
    mock.routes.set(VALUE_PATH, (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{not json");
    });

    const driver = await makeDriver();
    const bytes = new Uint8Array([1]) as Uint8Array<ArrayBuffer>;
    const result = await driver.store({ key: "export:render-1.mp4", bytes, mimeType: "video/mp4", ttlSeconds: 60 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid_response");
  });

  it("retries on a 5xx and succeeds on the next attempt", async () => {
    let attempts = 0;
    mock.routes.set(VALUE_PATH, (_req, res) => {
      attempts += 1;
      if (attempts === 1) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: false, errors: [{ message: "temporarily unavailable" }] }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: true, result: {}, errors: [], messages: [] }));
    });

    const driver = new KvExportDriver({
      accountId: "acct1",
      namespaceId: "ns1",
      apiToken: "test-token",
      baseUrl: await mock.baseUrl,
      maxAttempts: 2,
      baseDelayMs: 1,
    });
    const bytes = new Uint8Array([1, 2]) as Uint8Array<ArrayBuffer>;
    const result = await driver.store({ key: "export:render-1.mp4", bytes, mimeType: "video/mp4", ttlSeconds: 60 });

    expect(attempts).toBe(2);
    expect(result).toEqual({ ok: true, value: { key: "export:render-1.mp4", sizeBytes: 2 } });
  });
});
