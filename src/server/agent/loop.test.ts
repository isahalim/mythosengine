import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../../db/client.ts";
import { applyMigrations } from "../../../db/apply-migrations.ts";
import { createChatSession, getChatMessages } from "../console/chat.ts";
import { ok, type Result } from "../../lib/result.ts";
import type { DriverError, LlmDriver, LlmRequest, LlmResponse } from "../../lib/drivers/types.ts";
import type { ToolContext } from "./tools.ts";
import { runAgentTurn } from "./loop.ts";

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
