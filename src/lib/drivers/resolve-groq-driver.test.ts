import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGroqDriverFromEnv, createGroqLimiter } from "./resolve-groq-driver.ts";

/**
 * A server that refuses with a per-minute rate limit and asks for a wait
 * longer than any budget under test, so the driver's answer is immediate and
 * the assertion is about *which* budget it quotes rather than about sleeping.
 */
function startRateLimitedServer(retryAfterSeconds: number): { server: Server; baseUrl: Promise<string> } {
  const server = createServer((_req, res) => {
    res.writeHead(429, { "content-type": "application/json", "retry-after": String(retryAfterSeconds) });
    res.end(JSON.stringify({ error: { message: "on output tokens per minute (OTPM): Limit 1000", code: "rate_limit_exceeded" } }));
  });
  const baseUrl = new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("expected a network address");
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
  return { server, baseUrl };
}

describe("createGroqDriverFromEnv", () => {
  let mock: ReturnType<typeof startRateLimitedServer>;

  beforeEach(() => {
    mock = startRateLimitedServer(600);
  });

  afterEach(() => {
    mock.server.close();
  });

  /**
   * The 2026-09-04 evening render, pinned at the seam that caused it.
   *
   * `fetchWithRetry` defaults to a 5s ceiling on any one wait, which is the
   * right answer inside a Cloudflare Workers request and the wrong one in a
   * 180-minute GitHub Actions job. Groq's qwen3 output meter asked for 10s
   * and 15s that evening; both were refused as `rate_limited`, both rungs of
   * EDIT's ladder were spent on them inside 70 seconds, and five shots were
   * abandoned without a request ever being made for them.
   *
   * A 600s Retry-After is still refused — the point is what the refusal says
   * it was willing to wait, which is the only fast way to read the budget.
   */
  it("gives the pipeline a retry budget that can wait out a per-minute meter", async () => {
    const driver = createGroqDriverFromEnv("test-key", createGroqLimiter(), { baseUrl: await mock.baseUrl });

    const result = await driver.complete({ model: "qwen/qwen3.8-27b", messages: [{ role: "user", content: "trim it" }], maxTokens: 900 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("rate_limited");
    expect(result.error.message).toContain("exceeds the 60s retry budget");
  });
});
