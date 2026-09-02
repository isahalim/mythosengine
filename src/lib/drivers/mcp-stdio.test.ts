import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McpStdioClient } from "./mcp-stdio.ts";

const server = join(import.meta.dirname, "__fixtures__", "fake-mcp-server.mjs");

let client: McpStdioClient | undefined;

function connect(mode?: string, timeoutMs?: number): McpStdioClient {
  client = new McpStdioClient({
    command: process.execPath,
    args: [server],
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(mode === undefined ? {} : { env: { ...process.env, FAKE_MCP_MODE: mode } }),
  });
  return client;
}

afterEach(() => {
  client?.close();
  client = undefined;
});

describe("McpStdioClient", () => {
  it("completes the handshake and lists the server's tools", async () => {
    const mcp = connect();
    expect((await mcp.start()).ok).toBe(true);

    const tools = await mcp.listTools();
    expect(tools.ok).toBe(true);
    if (!tools.ok) return;
    expect(tools.value.some((t) => t.name === "video_info")).toBe(true);
    // Schemas come from the server, never hand-copied — a pasted schema
    // silently drifts on the server's next release.
    expect(tools.value.find((t) => t.name === "video_info")?.parameters).toMatchObject({ required: ["input_path"] });
  });

  it("skips a server's non-JSON log lines instead of choking on them", async () => {
    // The fixture writes "kinocut: ready" to stdout before any JSON-RPC. A
    // client that treats every stdout line as protocol dies on it.
    const mcp = connect();
    expect((await mcp.start()).ok).toBe(true);
    expect((await mcp.listTools()).ok).toBe(true);
  });

  it("drops a tool entry with no name rather than inventing one", async () => {
    const mcp = connect();
    await mcp.start();
    const tools = await mcp.listTools();
    expect(tools.ok && tools.value.every((t) => typeof t.name === "string" && t.name.length > 0)).toBe(true);
  });

  it("calls a tool and returns its text content", async () => {
    const mcp = connect();
    await mcp.start();
    const result = await mcp.callTool("video_info", { input_path: "/tmp/a.mp4" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.isError).toBe(false);
    expect(JSON.parse(result.value.text)).toMatchObject({ success: true, tool: "video_info", got: { input_path: "/tmp/a.mp4" } });
  });

  it("reports a tool that ran and failed as a result, not a transport fault", async () => {
    // `isError: true` is a real answer the model can often fix and retry, so
    // it must not be raised as a driver error.
    const mcp = connect("tool-error");
    await mcp.start();
    const result = await mcp.callTool("video_trim", { input_path: "/tmp/a.mp4" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.isError).toBe(true);
    expect(result.value.text).toContain("start past end");
  });

  it("surfaces a JSON-RPC error as a typed driver error", async () => {
    const mcp = connect();
    await mcp.start();
    const result = await mcp.callTool("explode", {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("tool blew up");
  });

  it("reports a malformed tools/list rather than pretending there are no tools", async () => {
    const mcp = connect("bad-list");
    await mcp.start();
    const tools = await mcp.listTools();
    expect(tools.ok).toBe(false);
    if (tools.ok) return;
    expect(tools.error.kind).toBe("invalid_response");
  });

  it("times out a server that accepts a request and never answers", async () => {
    // Otherwise a hung server hangs the render until the Actions job timeout
    // — the failure mode this codebase's timeout convention exists to stop.
    const mcp = connect("no-handshake", 250);
    const started = await mcp.start();
    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.error.kind).toBe("timeout");
  });

  it("degrades rather than crashing the process when the server binary is missing", async () => {
    // `spawn` reports ENOENT asynchronously, so this is NOT caught by a
    // try/catch around the spawn call. Without an `error` listener a missing
    // `uvx` becomes an unhandled exception that kills a render carrying a
    // finished script — the opposite of EDIT's fail-soft contract.
    const mcp = new McpStdioClient({ command: "definitely-not-a-real-binary-xyz", args: [], timeoutMs: 1000 });
    const started = await mcp.start();
    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.error.message).toContain("could not be started");
    mcp.close();
  });

  it("refuses to call a tool before the server is running", async () => {
    const mcp = new McpStdioClient({ command: process.execPath, args: [server] });
    const result = await mcp.callTool("video_info", {});
    expect(result.ok).toBe(false);
  });

  it("is safe to close twice", async () => {
    const mcp = connect();
    await mcp.start();
    mcp.close();
    expect(() => mcp.close()).not.toThrow();
  });
});
