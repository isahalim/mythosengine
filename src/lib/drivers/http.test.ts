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

  it("treats a 304 as a successful result, not an error, for conditional GETs", async () => {
    handler = (_req, res) => {
      res.writeHead(304);
      res.end();
    };
    const result = await fetchWithRetry(baseUrl, {}, { timeoutMs: 1000, maxAttempts: 2, baseDelayMs: 5 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe(304);
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

  // Regression: the 2026-08-29 console chat outage. A Groq
  // tokens-per-minute 429 came back asking for a wait longer than the
  // Worker request had left; the old code slept on it unconditionally, the
  // request was killed mid-sleep, and the turn died without persisting
  // anything -- the operator saw a bare `provider_error` and no answer.
  it("refuses a Retry-After longer than the retry budget instead of sleeping on it", async () => {
    let calls = 0;
    handler = (_req, res) => {
      calls++;
      res.writeHead(429, { "retry-after": "120" }); // two minutes
      res.end();
    };

    const startedAt = Date.now();
    const result = await fetchWithRetry(baseUrl, {}, { timeoutMs: 1000, maxAttempts: 3, baseDelayMs: 5, maxRetryDelayMs: 200 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("rate_limited");
      expect(result.error.message).toContain("exceeds the");
    }
    // Returned promptly, and without burning the remaining attempts.
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(calls).toBe(1);
  });

  it("names which quota was hit by folding the provider's x-ratelimit-* headers into the error", async () => {
    handler = (_req, res) => {
      res.writeHead(429, {
        "retry-after": "300",
        "x-ratelimit-limit-tokens": "8000",
        "x-ratelimit-remaining-tokens": "0",
        "x-ratelimit-reset-tokens": "5m0s",
        "x-ratelimit-remaining-requests": "998",
        "content-type": "text/plain",
      });
      res.end();
    };

    const result = await fetchWithRetry(baseUrl, {}, { timeoutMs: 1000, maxAttempts: 2, baseDelayMs: 5, maxRetryDelayMs: 100 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Tokens exhausted while requests are plentiful: the distinction that
    // separates "wait a minute" from "cut the payload", and which a bare
    // "rate_limited" hides completely.
    expect(result.error.message).toContain("x-ratelimit-remaining-tokens=0");
    expect(result.error.message).toContain("x-ratelimit-remaining-requests=998");
    expect(result.error.message).toContain("x-ratelimit-reset-tokens=5m0s");
    // Non-rate-limit headers stay out of it.
    expect(result.error.message).not.toContain("content-type");
  });

  it("still honors a Retry-After that fits inside the budget", async () => {
    let calls = 0;
    handler = (_req, res) => {
      calls++;
      if (calls === 1) {
        res.writeHead(429, { "retry-after": "0.05" });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end("ok");
    };
    const result = await fetchWithRetry(baseUrl, {}, { timeoutMs: 1000, maxAttempts: 2, baseDelayMs: 5, maxRetryDelayMs: 1000 });
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("caps plain exponential backoff at the retry budget too", async () => {
    let calls = 0;
    handler = (_req, res) => {
      calls++;
      if (calls < 3) {
        res.writeHead(503);
        res.end();
        return;
      }
      res.writeHead(200);
      res.end("ok");
    };
    const startedAt = Date.now();
    // baseDelayMs 10_000 would mean a 10s+ first backoff without the cap.
    const result = await fetchWithRetry(baseUrl, {}, { timeoutMs: 1000, maxAttempts: 3, baseDelayMs: 10_000, maxRetryDelayMs: 50 });
    expect(result.ok).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(2000);
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
