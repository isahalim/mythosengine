import { writeAuditLog } from "../audit.ts";
import { AGENT_TOOLS, type ToolContext } from "../agent/tools.ts";

// A real MCP server surface over the console's existing, already-safety-
// scoped AGENT_TOOLS allowlist (src/server/agent/tools.ts) — see
// docs/DECISIONS.md's MCP-as-runtime-integration ADR for why this exists
// and what it deliberately does not expose (no key rotation, no killswitch;
// AGENT_TOOLS never had either). This is the minimal stateless subset of
// MCP's Streamable HTTP transport an external tool-calling client actually
// needs — initialize, tools/list, tools/call — not a full stdio/SSE
// implementation, which a Worker can't run anyway (no subprocess support).
//
// `callMcpTool` is exported separately from the JSON-RPC framing so the
// in-console voice surface (src/server/agent/loop.ts's runAgentTurn) can
// dispatch a tool call through the exact same MCP tool contract and audit
// trail in-process, without a pointless self-addressed HTTP round trip.

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

function jsonRpcResult(id: unknown, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, result });
}

function jsonRpcError(id: unknown, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, { status: 200 });
}

/** Maps ToolDefinition (JSON-Schema, OpenAI function-calling shape) onto MCP's `tools/list` entry shape — same JSON Schema, different envelope key names. */
function listMcpTools(): { name: string; description: string; inputSchema: unknown }[] {
  return AGENT_TOOLS.map((t) => ({ name: t.definition.name, description: t.definition.description, inputSchema: t.definition.parameters }));
}

export interface McpToolCallResult {
  ok: boolean;
  data: unknown;
}

/**
 * Invokes one tool by name through the MCP tool contract, writing the same
 * audit trail runAgentTurn already writes for the text chat — actor "mcp"
 * distinguishes this path in audit_log without adding a new table/column.
 * `callerLabel` identifies who made the call (e.g. `session:<id>` for the
 * in-console voice surface, `token:<mcpTokenId>` for an external client) so
 * the trail stays traceable to a specific credential, not just "an MCP call happened."
 */
export async function callMcpTool(
  ctx: ToolContext,
  name: string,
  args: unknown,
  callerLabel: string,
  now: () => number = Date.now,
): Promise<McpToolCallResult> {
  const tool = AGENT_TOOLS.find((t) => t.definition.name === name);
  if (!tool) return { ok: false, data: { error: "unknown_tool" } };

  const result = await tool.execute(ctx, args);
  await writeAuditLog(ctx.db, "mcp", `tool.${name}`, callerLabel, { args, result }, now);
  return result;
}

/** Handles one POST /console/mcp JSON-RPC request. Returns a well-formed JSON-RPC response even on a malformed body or unknown method — never a bare 4xx/5xx, per the JSON-RPC 2.0 spec this endpoint advertises. */
export async function handleMcpRequest(body: unknown, ctx: ToolContext, callerLabel: string): Promise<Response> {
  const req = body as JsonRpcRequest;
  if (!req || typeof req.method !== "string") return jsonRpcError(req?.id, -32600, "invalid request: missing method");

  switch (req.method) {
    case "initialize":
      return jsonRpcResult(req.id, {
        protocolVersion: "2025-06-18",
        serverInfo: { name: "autoshorts-console", version: "1.0.0" },
        capabilities: { tools: {} },
      });

    case "tools/list":
      return jsonRpcResult(req.id, { tools: listMcpTools() });

    case "tools/call": {
      const params = req.params as { name?: string; arguments?: unknown } | undefined;
      if (!params || typeof params.name !== "string") return jsonRpcError(req.id, -32602, "invalid params: missing tool name");
      const result = await callMcpTool(ctx, params.name, params.arguments ?? {}, callerLabel);
      return jsonRpcResult(req.id, {
        content: [{ type: "text", text: JSON.stringify(result.data) }],
        isError: !result.ok,
      });
    }

    default:
      return jsonRpcError(req.id, -32601, `method not found: ${req.method}`);
  }
}
