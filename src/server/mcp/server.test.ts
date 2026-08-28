import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type AppDb } from "../../../db/client.ts";
import { applyMigrations } from "../../../db/apply-migrations.ts";
import { auditLog } from "../../../db/schema.ts";
import type { ToolContext } from "../agent/tools.ts";
import { callMcpTool, handleMcpRequest } from "./server.ts";

class FakeHotKv {
  private readonly strings = new Map<string, string>();
  private readonly blobs = new Map<string, ArrayBuffer>();
  get(key: string): Promise<string | null>;
  get(key: string, options: { type: "arrayBuffer" }): Promise<ArrayBuffer | null>;
  async get(key: string, options?: { type: "arrayBuffer" }): Promise<string | ArrayBuffer | null> {
    return options?.type === "arrayBuffer" ? (this.blobs.get(key) ?? null) : (this.strings.get(key) ?? null);
  }
  async put(key: string, value: string): Promise<void> {
    this.strings.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.strings.delete(key);
  }
}

const MASTER_KEY_B64 = "3q2-7_zdaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("MCP server", () => {
  let db: AppDb;
  let ctx: ToolContext;

  beforeEach(() => {
    const testDb = createTestDb();
    applyMigrations(testDb.client);
    db = testDb.db;
    const hotKv = new FakeHotKv();
    ctx = { db, rawClient: testDb.client, hotKv, vaultKv: hotKv, vaultMasterKey: MASTER_KEY_B64 };
  });

  it("initialize advertises tool capability", async () => {
    const res = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize" }, ctx, "session:test");
    const body = (await res.json()) as { result: { capabilities: { tools: unknown } } };
    expect(body.result.capabilities.tools).toEqual({});
  });

  it("tools/list returns the exact AGENT_TOOLS allowlist — no key rotation, no killswitch", async () => {
    const res = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }, ctx, "session:test");
    const body = (await res.json()) as { result: { tools: { name: string }[] } };
    const names = body.result.tools.map((t) => t.name);
    expect(names).toContain("get_summary");
    expect(names).toContain("dispatch_run");
    expect(names).not.toContain("rotate_key");
    expect(names).not.toContain("set_killswitch");
  });

  it("tools/call invokes the real tool and returns its result", async () => {
    const res = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_summary", arguments: {} } }, ctx, "session:test");
    const body = (await res.json()) as { result: { content: { type: string; text: string }[]; isError: boolean } };
    expect(body.result.isError).toBe(false);
    expect(JSON.parse(body.result.content[0].text)).toHaveProperty("pipelinePulse");
  });

  it("a call for a nonexistent tool name returns a normal tool-not-found error, never a 500 or a bypass", async () => {
    const res = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "rotate_key", arguments: {} } }, ctx, "session:test");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { isError: boolean; content: { text: string }[] } };
    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content[0].text)).toEqual({ error: "unknown_tool" });
  });

  it("an unknown method returns a JSON-RPC error, not a thrown exception", async () => {
    const res = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "not_a_real_method" }, ctx, "session:test");
    const body = (await res.json()) as { error: { code: number } };
    expect(res.status).toBe(200);
    expect(body.error.code).toBe(-32601);
  });

  it("callMcpTool writes an audit_log row tagged actor='mcp' with the caller label as subject", async () => {
    await callMcpTool(ctx, "get_summary", {}, "token:abc123");
    const rows = await db.select().from(auditLog).all();
    const row = rows.find((r) => r.action === "tool.get_summary");
    expect(row?.actor).toBe("mcp");
    expect(row?.subject).toBe("token:abc123");
  });
});
