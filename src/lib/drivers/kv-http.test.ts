import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KvHttpClient } from "./kv-http.ts";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

function startMockServer(): { server: Server; baseUrl: Promise<string>; queue: (handler: Handler) => void } {
  const handlers: Handler[] = [];
  const defaultHandler: Handler = (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: true, errors: [], messages: [], result: null }));
  };

  const server = createServer((req, res) => {
    (handlers.shift() ?? defaultHandler)(req, res);
  });

  const baseUrl = new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("expected a network address");
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });

  return { server, baseUrl, queue: (h) => handlers.push(h) };
}

describe("KvHttpClient", () => {
  let mock: ReturnType<typeof startMockServer>;

  beforeEach(() => {
    mock = startMockServer();
  });

  afterEach(() => {
    mock.server.close();
  });

  it("returns the raw value body on a successful GET", async () => {
    mock.queue((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("true");
    });
    const client = new KvHttpClient({ accountId: "acct", namespaceId: "ns", apiToken: "token", baseUrl: await mock.baseUrl, maxAttempts: 1, timeoutMs: 2000 });
    expect(await client.get("PIPELINE_ENABLED")).toBe("true");
  });

  it("returns null on a 404 (key never set)", async () => {
    mock.queue((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    const client = new KvHttpClient({ accountId: "acct", namespaceId: "ns", apiToken: "token", baseUrl: await mock.baseUrl, maxAttempts: 1, timeoutMs: 2000 });
    expect(await client.get("PIPELINE_ENABLED")).toBeNull();
  });

  it("PUTs the value with the expiration_ttl query param when given a TTL", async () => {
    let capturedUrl = "";
    mock.queue((req, res) => {
      capturedUrl = req.url ?? "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: true, errors: [], messages: [] }));
    });
    const client = new KvHttpClient({ accountId: "acct", namespaceId: "ns", apiToken: "token", baseUrl: await mock.baseUrl, maxAttempts: 1, timeoutMs: 2000 });
    await client.put("k", "v", { expirationTtl: 60 });
    expect(capturedUrl).toContain("expiration_ttl=60");
  });

  it("throws when the PUT envelope reports success: false", async () => {
    mock.queue((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: false, errors: [{ code: 10014, message: "value too large" }] }));
    });
    const client = new KvHttpClient({ accountId: "acct", namespaceId: "ns", apiToken: "token", baseUrl: await mock.baseUrl, maxAttempts: 1, timeoutMs: 2000 });
    await expect(client.put("k", "v")).rejects.toThrow(/value too large/);
  });
});
