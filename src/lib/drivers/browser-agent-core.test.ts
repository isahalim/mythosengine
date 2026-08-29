import { createServer, type Server } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launchBrowserSession, runBrowserAgentTask } from "./browser-agent-core.ts";
import type { DriverError, LlmDriver, LlmRequest, LlmResponse, ToolCall } from "./types.ts";
import { ok, type Result } from "../result.ts";

const PAGE_HTML = `<!doctype html>
<html><body>
<input aria-label="Search box" />
<button onclick="document.getElementById('status').textContent='clicked'; document.getElementById('dl').style.display='inline'">Click me</button>
<span id="status">idle</span>
<a id="dl" href="/file.txt" download="file.txt" style="display:none">Download file</a>
<a href="https://example.com/elsewhere">External link</a>
</body></html>`;

function startFixtureServer(): { server: Server; baseUrl: Promise<string> } {
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/file.txt")) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("hello");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(PAGE_HTML);
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

/** Same shape as src/server/agent/loop.test.ts's ScriptedLlm — a queue of canned responses, real Playwright driving a real (fixture) page underneath. Also records every request sent, so a test can inspect what tool-result content the model actually saw. */
class ScriptedLlm implements LlmDriver {
  calls: LlmRequest[] = [];
  private i = 0;
  constructor(private readonly responses: LlmResponse[]) {}
  async complete(req: LlmRequest): Promise<Result<LlmResponse, DriverError>> {
    // Snapshot messages — runBrowserAgentTask keeps pushing to the same
    // array across iterations, so recording the live reference would make
    // every earlier recorded call retroactively show later iterations' messages too.
    this.calls.push({ ...req, messages: [...req.messages] });
    const response = this.responses[this.i];
    this.i++;
    return ok(response ?? { content: "", finishReason: "stop", quotaRemaining: null, tokensUsed: null });
  }
}

function toolCallResponse(call: ToolCall): LlmResponse {
  return { content: "", finishReason: "tool_calls", quotaRemaining: null, tokensUsed: null, toolCalls: [call] };
}

const FinishSchema = z.object({ label: z.string() });
const finishTool = {
  name: "report_result",
  description: "report",
  parameters: { type: "object", properties: { label: { type: "string" } }, required: ["label"] },
  schema: FinishSchema,
};

describe("browser-agent-core", () => {
  let fixture: ReturnType<typeof startFixtureServer>;
  let baseUrl: string;

  beforeEach(async () => {
    fixture = startFixtureServer();
    baseUrl = await fixture.baseUrl;
  });

  afterEach(() => {
    fixture.server.close();
  });

  it("navigates, clicks, fills, waits for a download, and returns the finish tool's args", async () => {
    const downloadsDir = await mktempDir();
    const session = await launchBrowserSession([baseUrl]);
    try {
      const llm = new ScriptedLlm([
        toolCallResponse({ id: "1", name: "browser_navigate", argumentsJson: JSON.stringify({ url: baseUrl }) }),
        toolCallResponse({ id: "2", name: "browser_fill", argumentsJson: JSON.stringify({ role: "textbox", name: "Search box", value: "hello world" }) }),
        toolCallResponse({ id: "3", name: "browser_click", argumentsJson: JSON.stringify({ role: "button", name: "Click me" }) }),
        toolCallResponse({ id: "4", name: "browser_click", argumentsJson: JSON.stringify({ role: "link", name: "Download file" }) }),
        toolCallResponse({ id: "5", name: "browser_wait_for_download", argumentsJson: "{}" }),
        toolCallResponse({ id: "6", name: finishTool.name, argumentsJson: JSON.stringify({ label: "done" }) }),
      ]);

      const result = await runBrowserAgentTask(
        { llm, page: session.page, allowedOrigins: [baseUrl], downloadsDir, systemPrompt: "test", userGoal: "test" },
        finishTool,
      );

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.label).toBe("done");

      // The click really happened on the real page, and the download really landed on disk.
      expect(await session.page.locator("#status").textContent()).toBe("clicked");
      const savedFiles = await readFile(join(downloadsDir, "file.txt"), "utf8");
      expect(savedFiles).toBe("hello");
    } finally {
      await session.close();
    }
  });

  it("aborts a top-level navigation to an origin outside the allowlist, and reports it back to the model", async () => {
    const session = await launchBrowserSession([baseUrl]);
    try {
      const llm = new ScriptedLlm([
        toolCallResponse({ id: "1", name: "browser_navigate", argumentsJson: JSON.stringify({ url: "https://example.com/somewhere" }) }),
        toolCallResponse({ id: "2", name: finishTool.name, argumentsJson: JSON.stringify({ label: "gave up" }) }),
      ]);

      const result = await runBrowserAgentTask(
        { llm, page: session.page, allowedOrigins: [baseUrl], downloadsDir: "", systemPrompt: "test", userGoal: "test" },
        finishTool,
      );

      expect(result.ok).toBe(true);

      // The 2nd LLM call's message history carries the 1st call's tool result —
      // that's the model's only view into what browser_navigate actually did.
      const secondRequestMessages = llm.calls[1]?.messages ?? [];
      const toolMessage = secondRequestMessages.find((m) => m.role === "tool");
      expect(toolMessage).toBeDefined();
      const parsed: unknown = JSON.parse(toolMessage?.content ?? "{}");
      expect(parsed).toMatchObject({ error: "origin_not_allowed" });
    } finally {
      await session.close();
    }
  });

  it("refuses to click a role outside the allowed set", async () => {
    const session = await launchBrowserSession([baseUrl]);
    try {
      const llm = new ScriptedLlm([
        toolCallResponse({ id: "1", name: "browser_navigate", argumentsJson: JSON.stringify({ url: baseUrl }) }),
        toolCallResponse({ id: "2", name: "browser_click", argumentsJson: JSON.stringify({ role: "region", name: "whatever" }) }),
        toolCallResponse({ id: "3", name: finishTool.name, argumentsJson: JSON.stringify({ label: "done" }) }),
      ]);

      await runBrowserAgentTask({ llm, page: session.page, allowedOrigins: [baseUrl], downloadsDir: "", systemPrompt: "test", userGoal: "test" }, finishTool);

      const thirdRequestMessages = llm.calls[2]?.messages ?? [];
      const toolMessage = thirdRequestMessages.find((m, i) => m.role === "tool" && i === thirdRequestMessages.length - 1);
      const parsed: unknown = JSON.parse(toolMessage?.content ?? "{}");
      expect(parsed).toMatchObject({ error: "role_not_allowed" });
    } finally {
      await session.close();
    }
  });

  it("fails with a retryable error when the model never calls the finish tool within maxIterations", async () => {
    const session = await launchBrowserSession([baseUrl]);
    try {
      const llm = new ScriptedLlm([
        toolCallResponse({ id: "1", name: "browser_navigate", argumentsJson: JSON.stringify({ url: baseUrl }) }),
        toolCallResponse({ id: "2", name: "browser_snapshot", argumentsJson: "{}" }),
        toolCallResponse({ id: "3", name: "browser_snapshot", argumentsJson: "{}" }),
      ]);

      const result = await runBrowserAgentTask(
        { llm, page: session.page, allowedOrigins: [baseUrl], downloadsDir: "", systemPrompt: "test", userGoal: "test", maxIterations: 2 },
        finishTool,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("invalid_response");
        expect(result.error.retryable).toBe(true);
      }
    } finally {
      await session.close();
    }
  });

  it("re-prompts instead of finishing when the model answers with no tool call at all", async () => {
    const session = await launchBrowserSession([baseUrl]);
    try {
      const llm = new ScriptedLlm([
        { content: "I think I'm done.", finishReason: "stop", quotaRemaining: null, tokensUsed: null },
        toolCallResponse({ id: "1", name: finishTool.name, argumentsJson: JSON.stringify({ label: "done" }) }),
      ]);

      const result = await runBrowserAgentTask({ llm, page: session.page, allowedOrigins: [baseUrl], downloadsDir: "", systemPrompt: "test", userGoal: "test" }, finishTool);

      expect(result.ok).toBe(true);
      expect(llm.calls.length).toBe(2);
    } finally {
      await session.close();
    }
  });
});

async function mktempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "browser-agent-core-test-"));
}
