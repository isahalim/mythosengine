import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GeminiLlmDriver } from "./gemini.ts";
import { TokenBucketLimiter } from "./rate-limiter.ts";

describe("GeminiLlmDriver", () => {
  let server: Server;
  let baseUrl: string;
  let handler: (req: IncomingMessage, res: ServerResponse) => void;
  let received: { headers: IncomingMessage["headers"]; body: Record<string, unknown> } | null;

  beforeEach(async () => {
    received = null;
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        received = { headers: req.headers, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} };
        handler(req, res);
      });
    });
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

  function driver() {
    return new GeminiLlmDriver({ apiKey: "test-key", limiter: new TokenBucketLimiter(100, 100_000), baseUrl, maxAttempts: 1 });
  }

  function respond(payload: unknown, status = 200) {
    handler = (_req, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
  }

  const OK_BODY = {
    status: "completed",
    usage: { total_tokens: 197 },
    steps: [{ type: "model_output", content: [{ type: "text", text: "the answer" }] }],
  };

  it("returns the model_output text on success", async () => {
    respond(OK_BODY);
    const result = await driver().complete({ model: "gemini-3.7-flash", messages: [{ role: "system", content: "hi" }] });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.content).toBe("the answer");
    expect(result.value.tokensUsed).toBe(197);
  });

  it("authenticates with x-goog-api-key, not a bearer token", async () => {
    respond(OK_BODY);
    await driver().complete({ model: "gemini-3.7-flash", messages: [{ role: "system", content: "hi" }] });
    expect(received?.headers["x-goog-api-key"]).toBe("test-key");
    expect(received?.headers.authorization).toBeUndefined();
  });

  it("skips `thought` steps — reading steps[0] would return the model's reasoning", async () => {
    respond({
      status: "completed",
      steps: [
        { type: "thought", signature: "EvEFCu4FAQw" },
        { type: "model_output", content: [{ type: "text", text: '{"hook":"real output"}' }] },
      ],
    });
    const result = await driver().complete({ model: "gemini-3.7-flash", messages: [{ role: "system", content: "hi" }] });
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.content).toBe('{"hook":"real output"}');
  });

  it("concatenates multiple text parts of the output step", async () => {
    respond({
      status: "completed",
      steps: [{ type: "model_output", content: [{ type: "text", text: "part one " }, { type: "text", text: "part two" }] }],
    });
    const result = await driver().complete({ model: "gemini-3.7-flash", messages: [{ role: "system", content: "hi" }] });
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.content).toBe("part one part two");
  });

  it("asks for JSON via response_format when jsonSchema is set", async () => {
    respond(OK_BODY);
    await driver().complete({ model: "gemini-3.7-flash", messages: [{ role: "system", content: "hi" }], jsonSchema: true });
    expect(received?.body.response_format).toEqual([{ type: "text", mime_type: "application/json" }]);
  });

  it("omits response_format entirely for a plain completion", async () => {
    respond(OK_BODY);
    await driver().complete({ model: "gemini-3.7-flash", messages: [{ role: "system", content: "hi" }] });
    expect(received?.body.response_format).toBeUndefined();
  });

  it("sends a lone message as the bare input string", async () => {
    respond(OK_BODY);
    await driver().complete({ model: "gemini-3.7-flash", messages: [{ role: "system", content: "just this" }] });
    expect(received?.body.input).toBe("just this");
  });

  it("labels roles when a repair retry adds a second message", async () => {
    respond(OK_BODY);
    await driver().complete({
      model: "gemini-3.7-flash",
      messages: [
        { role: "system", content: "write a script" },
        { role: "user", content: "that was not valid JSON" },
      ],
    });
    expect(received?.body.input).toBe("[system]\nwrite a script\n\n[user]\nthat was not valid JSON");
  });

  it("refuses a tool-calling request rather than silently dropping the tools", async () => {
    handler = () => {
      throw new Error("must not reach the network");
    };
    const result = await driver().complete({
      model: "gemini-3.7-flash",
      messages: [{ role: "system", content: "hi" }],
      tools: [{ name: "search_discourse", description: "d", parameters: { type: "object" } }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.retryable).toBe(false);
    expect(result.error.message).toContain("does not implement tool calling");
  });

  it("reports which steps it did see when there is no model_output", async () => {
    respond({ status: "failed", steps: [{ type: "thought" }] });
    const result = await driver().complete({ model: "gemini-3.7-flash", messages: [{ role: "system", content: "hi" }] });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.message).toContain("status=failed");
    expect(result.error.message).toContain("steps=[thought]");
  });

  it("fails cleanly on malformed JSON instead of throwing", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{not json");
    };
    const result = await driver().complete({ model: "gemini-3.7-flash", messages: [{ role: "system", content: "hi" }] });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.kind).toBe("invalid_response");
  });

  it("surfaces an HTTP error as a typed driver error", async () => {
    respond({ error: { message: "quota exhausted" } }, 429);
    const result = await driver().complete({ model: "gemini-3.7-flash", messages: [{ role: "system", content: "hi" }] });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.kind).toBe("rate_limited");
  });
});
