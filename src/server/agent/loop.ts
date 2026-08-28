import type { LlmDriver, LlmMessage } from "../../lib/drivers/types.ts";
import type { AppDb } from "../../../db/client.ts";
import { appendChatMessage, getChatMessages, type ChatMessageRow } from "../console/chat.ts";
import { writeAuditLog } from "../audit.ts";
import { AGENT_TOOLS, type ToolContext } from "./tools.ts";

const MODEL = "openai/gpt-oss-120b";
const MAX_TOOL_ITERATIONS = 6;

const SYSTEM_PROMPT = `You are the AutoShorts AI operator console's assistant. You can inspect the
pipeline's status and change its settings on the operator's behalf using
tools — you have no other way to affect anything.

Rules you must follow, not just prefer:
- You cannot rotate a provider key and you cannot touch the killswitch. No
  tool exists for either, on purpose — those require the operator's own
  fresh passkey approval. If asked, say so and point the operator at the
  dashboard.
- Never call activate_settings_update without first calling
  propose_settings_update on the exact same directive in this turn, and
  telling the operator what the preview showed.
- There is no tool that uploads or publishes anything to YouTube, ever —
  this system never does that automatically, by design. Do not imply
  otherwise.
- Be concise. State what you did or found, not what you're about to do.`;

function toWireHistory(rows: ChatMessageRow[]): LlmMessage[] {
  const out: LlmMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
  for (const row of rows) {
    if (row.role === "tool" && row.toolName) {
      out.push({
        role: "assistant",
        content: "",
        toolCalls: [{ id: row.id, name: row.toolName, argumentsJson: row.toolArgsJson ?? "{}" }],
      });
      out.push({ role: "tool", content: row.toolResultJson ?? "{}", toolCallId: row.id });
    } else {
      out.push({ role: row.role, content: row.content });
    }
  }
  return out;
}

export interface AgentTurnResult {
  finalMessage: string;
  toolCallsMade: string[];
}

/**
 * How a tool call the model asked for actually gets executed and audited.
 * Defaults to calling AGENT_TOOLS directly with actor "agent" (the text
 * chat's exact prior behavior, unchanged). The voice surface
 * (src/server/router.ts's /console/voice/turn) instead supplies an invoker
 * that dispatches through src/server/mcp/server.ts's callMcpTool, so a
 * voice-triggered action is audited as actor "mcp" — same AGENT_TOOLS
 * allowlist either way, just a different, traceable calling contract.
 */
export interface ToolInvoker {
  invoke(ctx: ToolContext, sessionId: string, name: string, args: unknown, now: () => number): Promise<{ ok: boolean; data: unknown }>;
}

const directToolInvoker: ToolInvoker = {
  async invoke(ctx, sessionId, name, args, now) {
    const toolDef = AGENT_TOOLS.find((t) => t.definition.name === name);
    const result = toolDef ? await toolDef.execute(ctx, args) : { ok: false, data: { error: "unknown_tool" } };
    await writeAuditLog(ctx.db, "agent", `tool.${name}`, sessionId, { args, result }, now);
    return result;
  },
};

/**
 * Runs one user turn to completion: appends the user message, loops the
 * model against AGENT_TOOLS until it stops calling tools (or hits
 * MAX_TOOL_ITERATIONS, to guarantee termination), persisting every step to
 * chat_messages as it goes so the "past chats" view always reflects exactly
 * what happened — including every tool call, since CONSOLE_SPEC.md's
 * "nothing hides an action from the reviewer" guarantee applies here too.
 */
export async function runAgentTurn(
  llm: LlmDriver,
  db: AppDb,
  ctx: ToolContext,
  sessionId: string,
  userContent: string,
  now: () => number = Date.now,
  invoker: ToolInvoker = directToolInvoker,
): Promise<AgentTurnResult> {
  await appendChatMessage(db, sessionId, "user", userContent, {}, now);

  const toolCallsMade: string[] = [];

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const history = await getChatMessages(db, sessionId);
    const messages = toWireHistory(history);

    const result = await llm.complete({
      model: MODEL,
      messages,
      tools: AGENT_TOOLS.map((t) => t.definition),
      toolChoice: "auto",
      maxTokens: 1024,
    });

    if (!result.ok) {
      const errorMessage = `I couldn't reach the model (${result.error.kind}): ${result.error.message}`;
      await appendChatMessage(db, sessionId, "assistant", errorMessage, {}, now);
      return { finalMessage: errorMessage, toolCallsMade };
    }

    const call = result.value.toolCalls?.[0];
    if (!call) {
      await appendChatMessage(db, sessionId, "assistant", result.value.content, {}, now);
      return { finalMessage: result.value.content, toolCallsMade };
    }

    let args: unknown;
    try {
      args = JSON.parse(call.argumentsJson);
    } catch {
      args = {};
    }

    const execResult = await invoker.invoke(ctx, sessionId, call.name, args, now);
    toolCallsMade.push(call.name);

    await appendChatMessage(
      db,
      sessionId,
      "tool",
      `ran ${call.name}`,
      { toolName: call.name, toolArgsJson: call.argumentsJson, toolResultJson: JSON.stringify(execResult.data) },
      now,
    );
  }

  const capMessage = "Reached the maximum number of tool calls for this turn — let me know if you'd like me to continue.";
  await appendChatMessage(db, sessionId, "assistant", capMessage, {}, now);
  return { finalMessage: capMessage, toolCallsMade };
}
