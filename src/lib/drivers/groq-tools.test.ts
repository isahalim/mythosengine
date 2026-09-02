import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GroqLlmDriver } from "./groq.ts";
import { TokenBucketLimiter } from "./rate-limiter.ts";

function startMockServer(): { server: Server; baseUrl: Promise<string>; lastRequestBody: () => unknown } {
  let lastBody: unknown;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      lastBody = JSON.parse(raw || "{}");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [{ id: "call_1", type: "function", function: { name: "get_summary", arguments: "{}" } }],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { total_tokens: 42 },
        }),
      );
    });
  });
  const baseUrl = new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("expected a network address");
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
  return { server, baseUrl, lastRequestBody: () => lastBody };
}

describe("GroqLlmDriver tool calling", () => {
  let mock: ReturnType<typeof startMockServer>;

  beforeEach(() => {
    mock = startMockServer();
  });

  afterEach(() => {
    mock.server.close();
  });

  function makeDriver(baseUrl: string) {
    return new GroqLlmDriver({ apiKey: "test", limiter: new TokenBucketLimiter(100, 100_000), baseUrl });
  }

  it("sends tool definitions in OpenAI function-calling wire format", async () => {
    const driver = makeDriver(await mock.baseUrl);
    await driver.complete({
      model: "openai/gpt-oss-120b",
      messages: [{ role: "user", content: "what's the pipeline status?" }],
      tools: [{ name: "get_summary", description: "Get the dashboard summary", parameters: { type: "object", properties: {} } }],
      toolChoice: "auto",
    });

    const body = mock.lastRequestBody() as { tools?: { type: string; function: { name: string } }[]; tool_choice?: string };
    expect(body.tools).toEqual([{ type: "function", function: { name: "get_summary", description: "Get the dashboard summary", parameters: { type: "object", properties: {} } } }]);
    expect(body.tool_choice).toBe("auto");
  });

  it("parses a tool-call response, including when content is null", async () => {
    const driver = makeDriver(await mock.baseUrl);
    const result = await driver.complete({ model: "openai/gpt-oss-120b", messages: [{ role: "user", content: "hi" }] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).toBe("");
      expect(result.value.toolCalls).toEqual([{ id: "call_1", name: "get_summary", argumentsJson: "{}" }]);
      expect(result.value.finishReason).toBe("tool_calls");
    }
  });

  it("serializes a prior assistant tool-call and its tool-result message back onto the wire", async () => {
    const driver = makeDriver(await mock.baseUrl);
    await driver.complete({
      model: "openai/gpt-oss-120b",
      messages: [
        { role: "user", content: "run the pipeline" },
        { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "dispatch_run", argumentsJson: "{}" }] },
        { role: "tool", content: '{"ok":true}', toolCallId: "call_1" },
      ],
    });

    const body = mock.lastRequestBody() as { messages: Record<string, unknown>[] };
    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "dispatch_run", arguments: "{}" } }],
    });
    expect(body.messages[2]).toEqual({ role: "tool", tool_call_id: "call_1", content: '{"ok":true}' });
  });
});

// Regression: Groq's free tier binds on tokens/minute, not requests/minute
// (its dashboard on 2026-08-29 showed ~6 req/min against a limit of 30,
// while tokens/min crossed 8K and returned rate_limit_exceeded). The
// limiter can only pace correctly if the estimate counts everything billed
// as input -- tool schemas included, since they are re-sent on every call
// of a tool-calling loop and are ~960 tokens for AGENT_TOOLS.
describe("GroqLlmDriver token accounting", () => {
  it("charges the limiter for tool definitions, not just message content", async () => {
    const charged: number[] = [];
    const recordingLimiter = {
      async acquire(estimatedTokens: number) {
        charged.push(estimatedTokens);
      },
    } as unknown as TokenBucketLimiter;

    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`;

    try {
      const driver = new GroqLlmDriver({ apiKey: "test", limiter: recordingLimiter, baseUrl });
      const messages = [{ role: "user" as const, content: "hi" }];

      await driver.complete({ model: "openai/gpt-oss-120b", messages, maxTokens: 100 });
      const withoutTools = charged[0];

      await driver.complete({
        model: "openai/gpt-oss-120b",
        messages,
        maxTokens: 100,
        tools: [
          {
            name: "a_tool_with_a_substantial_schema",
            description: "x".repeat(400),
            parameters: { type: "object", properties: { field: { type: "string", description: "y".repeat(400) } } },
          },
        ],
      });
      const withTools = charged[1];

      // ~800 characters of schema is ~200 tokens; the old estimate ignored
      // it entirely and charged exactly the same for both calls.
      expect(withTools).toBeGreaterThan(withoutTools + 150);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("GroqLlmDriver tool_use_failed recovery", () => {
  /** A server that answers every request with one canned status and body. */
  function respondWith(status: number, body: string): { server: Server; baseUrl: Promise<string> } {
    const server = createServer((_req, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
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

  it("recovers the model's structured output when Groq rejects its own `json` pseudo-tool", async () => {
    // The exact shape that lost the 2026-09-02 render its grounding:
    // gpt-oss delivered a finished research brief by "calling" a tool named
    // `json`, Groq validated the generation against the request's tool list
    // and 400'd, and RESEARCH reported a provider error over a brief that
    // was complete.
    const brief = { summary: "Iceland held a referendum on restarting EU accession talks.", key_points: ["the vote was tight"] };
    const mock = respondWith(
      400,
      JSON.stringify({
        error: {
          message: "Tool call validation failed: attempted to call tool 'json' which was not in request.tools",
          type: "invalid_request_error",
          code: "tool_use_failed",
          failed_generation: JSON.stringify({ name: "json", arguments: brief }),
        },
      }),
    );
    try {
      const driver = new GroqLlmDriver({
        apiKey: "test",
        limiter: new TokenBucketLimiter(100, 100_000),
        baseUrl: await mock.baseUrl,
        maxAttempts: 1,
      });
      const result = await driver.complete({ model: "openai/gpt-oss-120b", messages: [{ role: "user", content: "research this" }] });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(JSON.parse(result.value.content)).toEqual(brief);
      // Recorded as what it was, so the audit trail does not claim a clean turn.
      expect(result.value.finishReason).toBe("tool_use_failed_recovered");
      expect(result.value.toolCalls).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => mock.server.close(() => resolve()));
    }
  });

  it("leaves every other 400 an error — this is not 'make failures look like successes'", async () => {
    const mock = respondWith(400, JSON.stringify({ error: { message: "model `x` does not exist", type: "invalid_request_error" } }));
    try {
      const driver = new GroqLlmDriver({
        apiKey: "test",
        limiter: new TokenBucketLimiter(100, 100_000),
        baseUrl: await mock.baseUrl,
        maxAttempts: 1,
      });
      const result = await driver.complete({ model: "openai/gpt-oss-120b", messages: [{ role: "user", content: "hi" }] });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain("does not exist");
    } finally {
      await new Promise<void>((resolve) => mock.server.close(() => resolve()));
    }
  });

  it("keeps a tool_use_failed with no recoverable generation as an error", async () => {
    const mock = respondWith(400, JSON.stringify({ error: { code: "tool_use_failed", failed_generation: JSON.stringify({ name: "json" }) } }));
    try {
      const driver = new GroqLlmDriver({
        apiKey: "test",
        limiter: new TokenBucketLimiter(100, 100_000),
        baseUrl: await mock.baseUrl,
        maxAttempts: 1,
      });
      const result = await driver.complete({ model: "openai/gpt-oss-120b", messages: [{ role: "user", content: "hi" }] });
      expect(result.ok).toBe(false);
    } finally {
      await new Promise<void>((resolve) => mock.server.close(() => resolve()));
    }
  });
});
