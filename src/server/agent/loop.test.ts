import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../../db/client.ts";
import { applyMigrations } from "../../../db/apply-migrations.ts";
import { createChatSession, getChatMessages } from "../console/chat.ts";
import { ok, type Result } from "../../lib/result.ts";
import type { DriverError, LlmDriver, LlmRequest, LlmResponse } from "../../lib/drivers/types.ts";
import type { ToolContext } from "./tools.ts";
import { runAgentTurn, type ToolInvoker } from "./loop.ts";

class ScriptedLlm implements LlmDriver {
  private call = 0;
  constructor(private readonly responses: LlmResponse[]) {}
  async complete(_req: LlmRequest): Promise<Result<LlmResponse, DriverError>> {
    const response = this.responses[this.call];
    this.call++;
    return ok(response);
  }
  callCount(): number {
    return this.call;
  }
}

class FakeHotKv {
  private readonly strings = new Map<string, string>();
  get(key: string): Promise<string | null>;
  get(key: string, options: { type: "arrayBuffer" }): Promise<ArrayBuffer | null>;
  async get(key: string, _options?: { type: "arrayBuffer" }): Promise<string | ArrayBuffer | null> {
    return this.strings.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.strings.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.strings.delete(key);
  }
}

const MASTER_KEY_B64 = "3q2-7_zdaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("runAgentTurn", () => {
  let db: ReturnType<typeof createTestDb>;
  let ctx: ToolContext;

  beforeEach(() => {
    db = createTestDb();
    applyMigrations(db.client);
    const hotKv = new FakeHotKv();
    ctx = { db: db.db, rawClient: db.client, hotKv, vaultKv: hotKv, vaultMasterKey: MASTER_KEY_B64 };
  });

  it("answers directly when the model calls no tools", async () => {
    const session = await createChatSession(db.db);
    const llm = new ScriptedLlm([{ content: "The pipeline looks healthy.", finishReason: "stop", quotaRemaining: null, tokensUsed: null }]);

    const result = await runAgentTurn(llm, db.db, ctx, session.id, "how's it going?");
    expect(result.finalMessage).toBe("The pipeline looks healthy.");
    expect(result.toolCallsMade).toEqual([]);

    const messages = await getChatMessages(db.db, session.id);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("runs a tool call, persists it, and feeds the result back for a final answer", async () => {
    const session = await createChatSession(db.db);
    const llm = new ScriptedLlm([
      {
        content: "",
        finishReason: "tool_calls",
        quotaRemaining: null,
        tokensUsed: null,
        toolCalls: [{ id: "call_1", name: "dispatch_run", argumentsJson: "{}" }],
      },
      { content: "Queued a run for you.", finishReason: "stop", quotaRemaining: null, tokensUsed: null },
    ]);

    const result = await runAgentTurn(llm, db.db, ctx, session.id, "kick off a run");
    expect(result.toolCallsMade).toEqual(["dispatch_run"]);
    expect(result.finalMessage).toBe("Queued a run for you.");

    const messages = await getChatMessages(db.db, session.id);
    expect(messages.map((m) => m.role)).toEqual(["user", "tool", "assistant"]);
    expect(messages[1].toolName).toBe("dispatch_run");
    expect(JSON.parse(messages[1].toolResultJson ?? "{}")).toMatchObject({ kind: "queued" });
  });

  it("never lets the model call an excluded action — there is no tool for it to invoke in the first place", async () => {
    const session = await createChatSession(db.db);
    // Even if a model somehow returned a tool_call naming something outside
    // AGENT_TOOLS, the loop resolves it to an unknown-tool failure rather
    // than executing anything.
    const llm = new ScriptedLlm([
      { content: "", finishReason: "tool_calls", quotaRemaining: null, tokensUsed: null, toolCalls: [{ id: "call_1", name: "rotate_key", argumentsJson: "{}" }] },
      { content: "I can't rotate keys — please do that from the dashboard.", finishReason: "stop", quotaRemaining: null, tokensUsed: null },
    ]);

    const result = await runAgentTurn(llm, db.db, ctx, session.id, "rotate the groq key");
    const messages = await getChatMessages(db.db, session.id);
    expect(JSON.parse(messages[1].toolResultJson ?? "{}")).toEqual({ error: "unknown_tool" });
    expect(result.finalMessage).toContain("dashboard");
  });

  // Regression: the 2026-08-29 console outage. `mcp_tokens` was missing from
  // production D1, so get_summary failed, and the model re-called it every
  // iteration. Each get_summary is ~12 D1 queries, so the turn exhausted the
  // Worker's subrequest budget and 500'd before writing any assistant
  // message — the operator's question just vanished. The loop now refuses to
  // re-run a call signature that already failed this turn.
  it("runs a failing tool at most once per turn, so a broken tool cannot burn the whole budget", async () => {
    const session = await createChatSession(db.db);
    let invocations = 0;
    const failingInvoker: ToolInvoker = {
      async invoke() {
        invocations++;
        return { ok: false, data: { error: 'Failed query: select ... from "mcp_tokens"' } };
      },
    };
    const retryForever: LlmResponse = {
      content: "",
      finishReason: "tool_calls",
      quotaRemaining: null,
      tokensUsed: null,
      toolCalls: [{ id: "call_x", name: "get_summary", argumentsJson: "{}" }],
    };
    const llm = new ScriptedLlm(Array(10).fill(retryForever));

    const result = await runAgentTurn(llm, db.db, ctx, session.id, "status of pipeline", Date.now, failingInvoker);

    expect(invocations).toBe(1);
    expect(result.toolCallsMade).toEqual(["get_summary"]);

    const messages = await getChatMessages(db.db, session.id);
    const toolRows = messages.filter((m) => m.role === "tool");
    expect(JSON.parse(toolRows[0].toolResultJson ?? "{}")).toMatchObject({ error: expect.stringContaining("mcp_tokens") });
    // Every later attempt is recorded honestly as "not re-run", carrying the
    // original error so the model can actually report it.
    for (const row of toolRows.slice(1)) {
      expect(JSON.parse(row.toolResultJson ?? "{}")).toMatchObject({
        error: "already_failed_this_turn",
        originalError: { error: expect.stringContaining("mcp_tokens") },
      });
    }
  });

  it("still re-runs a tool that succeeded, since only failures are latched", async () => {
    const session = await createChatSession(db.db);
    let invocations = 0;
    const okInvoker: ToolInvoker = {
      async invoke() {
        invocations++;
        return { ok: true, data: { kind: "queued" } };
      },
    };
    const callAgain: LlmResponse = {
      content: "",
      finishReason: "tool_calls",
      quotaRemaining: null,
      tokensUsed: null,
      toolCalls: [{ id: "call_x", name: "dispatch_run", argumentsJson: "{}" }],
    };
    const llm = new ScriptedLlm([callAgain, callAgain, { content: "Queued two runs.", finishReason: "stop", quotaRemaining: null, tokensUsed: null }]);

    await runAgentTurn(llm, db.db, ctx, session.id, "run it twice", Date.now, okInvoker);
    expect(invocations).toBe(2);
  });

  it("terminates after MAX_TOOL_ITERATIONS even if the model never stops calling tools", async () => {
    const session = await createChatSession(db.db);
    const infiniteToolCall: LlmResponse = {
      content: "",
      finishReason: "tool_calls",
      quotaRemaining: null,
      tokensUsed: null,
      toolCalls: [{ id: "call_x", name: "get_summary", argumentsJson: "{}" }],
    };
    const llm = new ScriptedLlm(Array(10).fill(infiniteToolCall));

    const result = await runAgentTurn(llm, db.db, ctx, session.id, "loop forever");
    expect(result.finalMessage).toContain("maximum number of tool calls");
    expect(llm.callCount()).toBeLessThanOrEqual(6);
  });
});
