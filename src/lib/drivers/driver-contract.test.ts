import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GroqLlmDriver } from "./groq.ts";
import { TokenBucketLimiter } from "./rate-limiter.ts";
import type { LlmDriver } from "./types.ts";

type Handler = (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void;

/**
 * The mock server every LLM driver's contract test runs against
 * (AGENT_PLAYBOOK.md Task 1.2). Queue handlers with `queue()`; unqueued
 * requests get a default valid success response.
 */
function startMockServer(): { server: Server; baseUrl: Promise<string>; queue: (handler: Handler) => void } {
  const handlers: Handler[] = [];
  const defaultHandler: Handler = (_req, res) => {
    res.writeHead(200, { "content-type": "application/json", "x-ratelimit-remaining-requests": "29" });
    res.end(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { total_tokens: 12 } }));
  };

  const server = createServer((req, res) => {
    const handler = handlers.shift() ?? defaultHandler;
    handler(req, res);
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

function contractSuite(name: string, makeDriver: (baseUrl: string) => LlmDriver) {
  describe(`driver contract: ${name}`, () => {
    let mock: ReturnType<typeof startMockServer>;

    beforeEach(() => {
      mock = startMockServer();
    });

    afterEach(() => {
      mock.server.close();
    });

    const request = { model: "test-model", messages: [{ role: "user" as const, content: "hi" }] };

    it("returns content on a normal 200 response", async () => {
      const driver = makeDriver(await mock.baseUrl);
      const result = await driver.complete(request);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.content).toBe("ok");
    });

    it("retries once on a 429 then succeeds", async () => {
      mock.queue((_req, res) => {
        res.writeHead(429, { "retry-after": "0" });
        res.end();
      });
      const driver = makeDriver(await mock.baseUrl);
      const result = await driver.complete(request);
      expect(result.ok).toBe(true);
    });

    it("fails with a retryable error when 429 exhausts all retries", async () => {
      for (let i = 0; i < 5; i++) {
        mock.queue((_req, res) => {
          res.writeHead(429, { "retry-after": "0" });
          res.end();
        });
      }
      const driver = makeDriver(await mock.baseUrl);
      const result = await driver.complete(request);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("rate_limited");
        expect(result.error.retryable).toBe(true);
      }
    });

    it("times out on a hanging response and reports a retryable timeout", async () => {
      for (let i = 0; i < 5; i++) {
        mock.queue((_req, res) => {
          // never respond — the driver's AbortSignal.timeout must fire
          void res;
        });
      }
      const driver = makeDriver(await mock.baseUrl);
      const result = await driver.complete(request);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("timeout");
        expect(result.error.retryable).toBe(true);
      }
    }, 20_000);

    it("fails cleanly on malformed JSON instead of throwing", async () => {
      mock.queue((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{not json");
      });
      const driver = makeDriver(await mock.baseUrl);
      const result = await driver.complete(request);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("invalid_response");
    });

    it("fails cleanly when the response body is valid JSON but not an object", async () => {
      mock.queue((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("null");
      });
      const driver = makeDriver(await mock.baseUrl);
      const result = await driver.complete(request);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("invalid_response");
    });

    it("fails cleanly on an empty/shape-mismatched response", async () => {
      mock.queue((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({}));
      });
      const driver = makeDriver(await mock.baseUrl);
      const result = await driver.complete(request);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("invalid_response");
    });

    it("does not retry a non-retryable 4xx", async () => {
      mock.queue((_req, res) => {
        res.writeHead(401);
        res.end();
      });
      const driver = makeDriver(await mock.baseUrl);
      const result = await driver.complete(request);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.retryable).toBe(false);
    });
  });
}

contractSuite("GroqLlmDriver", (baseUrl) => {
  const limiter = new TokenBucketLimiter(30, 6000);
  return new GroqLlmDriver({ apiKey: "test-key", limiter, baseUrl, maxAttempts: 3, timeoutMs: 300, baseDelayMs: 10 });
});
