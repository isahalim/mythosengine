import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fetchWithRetry } from "./http.ts";

describe("fetchWithRetry", () => {
  let server: Server;
  let baseUrl: string;
  let handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void;

  beforeEach(async () => {
    server = createServer((req, res) => handler(req, res));
    baseUrl = await new Promise<string>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("expected a network address");
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });
  });

  afterEach(() => {
    server.close();
  });

  it("falls back to exponential backoff when a 429 has no Retry-After header", async () => {
    let calls = 0;
    handler = (_req, res) => {
      calls++;
      if (calls === 1) {
        res.writeHead(429); // no retry-after header at all
        res.end();
        return;
      }
      res.writeHead(200);
      res.end("ok");
    };
    const result = await fetchWithRetry(baseUrl, {}, { timeoutMs: 1000, maxAttempts: 2, baseDelayMs: 5 });
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("falls back to exponential backoff when Retry-After is not a number", async () => {
    let calls = 0;
    handler = (_req, res) => {
      calls++;
      if (calls === 1) {
        res.writeHead(429, { "retry-after": "not-a-number" });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end("ok");
    };
    const result = await fetchWithRetry(baseUrl, {}, { timeoutMs: 1000, maxAttempts: 2, baseDelayMs: 5 });
    expect(result.ok).toBe(true);
  });

  it("retries a non-Error network throw and reports it via String(cause) on the last attempt", async () => {
    let calls = 0;
    const flakyFetch: typeof fetch = async () => {
      calls++;
      throw "connection reset"; // a driver's fetchImpl throwing a non-Error value
    };
    const result = await fetchWithRetry(
      baseUrl,
      {},
      { timeoutMs: 1000, maxAttempts: 2, baseDelayMs: 5, fetchImpl: flakyFetch },
    );
    expect(calls).toBe(2);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("network");
      expect(result.error.message).toBe("connection reset");
    }
  });
});
