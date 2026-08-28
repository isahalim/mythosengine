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
