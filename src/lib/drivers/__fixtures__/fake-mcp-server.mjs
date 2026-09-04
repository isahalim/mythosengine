#!/usr/bin/env node
// A stub MCP server over stdio, for McpStdioClient's contract tests.
//
// Speaks the same newline-delimited JSON-RPC the real Kinocut server does,
// and deliberately also does two things a real server does that a naive
// client gets wrong: it logs a non-JSON line to stdout, and it answers out
// of order.
import { createInterface } from "node:readline";

const MODE = process.argv[2] ?? process.env.FAKE_MCP_MODE ?? "ok";

// A plain log line on stdout. A client that treats every stdout line as
// JSON-RPC dies here; this one must skip it.
process.stdout.write("kinocut: ready\n");

const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === "notifications/initialized") return;

  if (msg.method === "initialize") {
    if (MODE === "no-handshake") return; // never answers
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake", version: "1" } } });
    return;
  }

  if (msg.method === "tools/list") {
    if (MODE === "bad-list") {
      send({ jsonrpc: "2.0", id: msg.id, result: { nope: true } });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: [
          { name: "video_info", description: "probe", inputSchema: { type: "object", properties: { input_path: { type: "string" } }, required: ["input_path"] } },
          { name: "video_trim", description: "trim", inputSchema: { type: "object", properties: { input_path: { type: "string" } }, required: ["input_path"] } },
          { name: "video_detect_scenes", description: "scenes", inputSchema: { type: "object" } },
          { name: "video_filter", description: "filter", inputSchema: { type: "object" } },
          { name: "effect_vignette", description: "vignette", inputSchema: { type: "object" } },
          { name: "effect_glow", description: "glow", inputSchema: { type: "object" } },
          { name: "effect_chromatic_aberration", description: "ca", inputSchema: { type: "object" } },
          { name: "effect_scanlines", description: "scanlines", inputSchema: { type: "object" } },
          { name: "effect_noise", description: "noise", inputSchema: { type: "object" } },
          // The 187 others EDIT must NOT offer the model.
          { name: "video_publish_gate", description: "publish", inputSchema: { type: "object" } },
          { name: "hyperframes_render", description: "render", inputSchema: { type: "object" } },
          { name: "not-a-tool" },
        ],
      },
    });
    return;
  }

  if (msg.method === "tools/call") {
    const { name, arguments: args } = msg.params ?? {};
    if (name === "explode") {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "tool blew up" } });
      return;
    }
    if (name === "video_trim" && MODE === "tool-error") {
      send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: '{"error":"start past end"}' }], isError: true } });
      return;
    }
    // Kinocut answers a render with the path it wrote; a probe carries no
    // `output_path` at all. EDIT reads that field to recover a finished trim
    // when the model's own closing line does not survive, so the stub has to
    // reproduce the distinction rather than answer every call alike.
    const wrote = name === "video_trim" ? { output_path: args?.output_path ?? "/tmp/kinocut-generated.mp4" } : {};
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify({ success: true, tool: name, got: args ?? null, ...wrote }) }] } });
    return;
  }

  send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
});
