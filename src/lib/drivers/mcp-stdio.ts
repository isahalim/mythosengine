import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { DriverError, ToolDefinition } from "./types.ts";
import { err, ok, type Result } from "../result.ts";

/**
 * A minimal MCP client over stdio — enough to list a server's tools and call
 * them, and nothing else.
 *
 * **Why this is hand-written rather than `@modelcontextprotocol/sdk`.** The
 * same reasoning that keeps retrieval out of a framework
 * (ARCHITECTURE.md §5.2.5: "the loop below is thirty lines, and
 * CrewAI/LangGraph would add a dependency and an indirection without adding
 * a capability this needs"). This pipeline speaks to exactly one MCP server,
 * over stdio, using three methods — `initialize`, `tools/list`, `tools/call`.
 * That is newline-delimited JSON-RPC, which is what the code below is. The
 * SDK would bring a dependency, a transport abstraction and a lifecycle
 * model to buy none of the sampling, resources, prompts or roots this uses.
 *
 * If this ever needs resources, subscriptions, or a second transport, the
 * SDK becomes the right answer and this file is the seam to replace.
 *
 * **Everything a server returns is untrusted input** (AGENT_PLAYBOOK.md's
 * MCP hygiene note). Tool *results* here are file paths and JSON status
 * blobs that get handed back to a model; nothing from this boundary is
 * executed, interpolated into a shell command, or written to the database
 * without validation.
 */

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
}

export interface McpToolResult {
  /** The text blocks the tool returned, joined. Kinocut answers with a JSON string. */
  text: string;
  isError: boolean;
}

export interface McpStdioOptions {
  command: string;
  args: string[];
  /** Per-request ceiling. A video filter on a 20-second clip is seconds of work; a stuck server must not hang a render. */
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_TIMEOUT_MS = 180_000;

/** MCP's own tool descriptor, as `tools/list` returns it. */
interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export class McpStdioClient {
  private proc: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<number, (response: JsonRpcResponse) => void>();
  private readonly timeoutMs: number;
  private exitReason: string | null = null;

  constructor(private readonly options: McpStdioOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Starts the server and completes the handshake.
   *
   * The `initialized` notification is not optional politeness — a server
   * that has not received it is entitled to reject every subsequent call,
   * and the resulting failure looks like a broken tool rather than a broken
   * handshake.
   */
  async start(): Promise<Result<void, DriverError>> {
    try {
      this.proc = spawn(this.options.command, this.options.args, {
        stdio: ["pipe", "pipe", "pipe"],
        ...(this.options.cwd === undefined ? {} : { cwd: this.options.cwd }),
        ...(this.options.env === undefined ? {} : { env: this.options.env }),
      });
    } catch (cause) {
      return err({ kind: "provider_error", message: `could not start MCP server "${this.options.command}": ${cause instanceof Error ? cause.message : String(cause)}`, retryable: false });
    }

    const proc = this.proc;
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => this.onData(chunk));

    // stderr is the server's log, not its protocol. Captured for the error
    // message rather than discarded — "kino: ffmpeg not found" on stderr is
    // the entire diagnosis when every tool call starts failing.
    let stderrTail = "";
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-2000);
    });

    const abandonPending = (reason: string): void => {
      this.exitReason = reason;
      // Anything still waiting will never be answered; fail it now rather
      // than at the timeout, so the caller sees the real reason.
      for (const resolve of this.pending.values()) resolve({ error: { message: reason } });
      this.pending.clear();
    };

    // **Required, not defensive.** `spawn` does not throw for a missing
    // binary — it emits `error` asynchronously, after the try/catch above
    // has already returned. Without this listener a missing `uvx` becomes an
    // unhandled ENOENT that takes down the whole render process, which is
    // the exact opposite of EDIT's contract: an absent Kinocut must degrade
    // the stage, not kill a run that has a finished script behind it.
    proc.on("error", (cause: Error) => {
      abandonPending(`MCP server "${this.options.command}" could not be started: ${cause.message}`);
      this.proc = undefined;
    });

    proc.on("exit", (code) => {
      abandonPending(`MCP server exited with code ${code ?? "null"}${stderrTail.trim() ? `: ${stderrTail.trim().slice(-500)}` : ""}`);
    });

    const init = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "mythosengine", version: "1.0" },
    });
    if (!init.ok) return err(init.error);

    this.notify("notifications/initialized", {});
    return ok(undefined);
  }

  /** The server's tools, as `ToolDefinition`s an `LlmDriver` can be handed directly. */
  async listTools(): Promise<Result<ToolDefinition[], DriverError>> {
    const response = await this.request("tools/list", {});
    if (!response.ok) return err(response.error);

    const result = response.value;
    if (typeof result !== "object" || result === null || !("tools" in result)) {
      return err({ kind: "invalid_response", message: "tools/list returned no tools array", retryable: false });
    }
    const raw = (result as { tools: unknown }).tools;
    if (!Array.isArray(raw)) {
      return err({ kind: "invalid_response", message: "tools/list returned a non-array tools field", retryable: false });
    }

    const tools: ToolDefinition[] = [];
    for (const entry of raw as McpTool[]) {
      if (typeof entry?.name !== "string") continue;
      tools.push({
        name: entry.name,
        description: typeof entry.description === "string" ? entry.description : "",
        parameters: entry.inputSchema ?? { type: "object", properties: {} },
      });
    }
    return ok(tools);
  }

  async callTool(name: string, args: unknown): Promise<Result<McpToolResult, DriverError>> {
    const response = await this.request("tools/call", { name, arguments: args });
    if (!response.ok) return err(response.error);

    const result = response.value;
    if (typeof result !== "object" || result === null) {
      return err({ kind: "invalid_response", message: `tools/call ${name} returned no result object`, retryable: false });
    }
    const { content, isError } = result as { content?: unknown; isError?: unknown };
    const text = Array.isArray(content)
      ? content
          .filter((block): block is { type: string; text: string } => typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string")
          .map((block) => block.text)
          .join("\n")
      : "";

    // `isError: true` is a tool that ran and failed — a real answer, not a
    // transport fault. It is returned rather than thrown so the caller can
    // feed the message back to the model, which is often able to fix its
    // own arguments and retry.
    return ok({ text, isError: isError === true });
  }

  /** Stops the server. Safe to call twice, and safe to call on one that never started. */
  close(): void {
    this.proc?.kill();
    this.proc = undefined;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    // Newline-delimited JSON. A partial line at the end of a chunk is normal
    // and is kept in the buffer for the next one.
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
      if (line.length === 0) continue;

      let message: JsonRpcResponse;
      try {
        message = JSON.parse(line) as JsonRpcResponse;
      } catch {
        // A server that logs to stdout emits lines that are not JSON-RPC.
        // Skipping them is correct; failing on them would make this client
        // hostage to a server's logging.
        continue;
      }
      if (typeof message.id !== "number") continue; // a notification from the server
      const resolve = this.pending.get(message.id);
      if (resolve === undefined) continue;
      this.pending.delete(message.id);
      resolve(message);
    }
  }

  private notify(method: string, params: unknown): void {
    this.proc?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private request(method: string, params: unknown): Promise<Result<unknown, DriverError>> {
    if (this.proc === undefined) {
      return Promise.resolve(err({ kind: "provider_error", message: this.exitReason ?? "MCP server is not running", retryable: false } as DriverError));
    }
    const id = this.nextId++;

    return new Promise<Result<unknown, DriverError>>((resolve) => {
      // Every request is bounded. A server that accepts a call and never
      // answers would otherwise hang the render until the Actions job
      // timeout, which is the failure mode this whole codebase's
      // `AbortSignal.timeout` convention exists to prevent.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(err({ kind: "timeout", message: `MCP ${method} did not answer within ${this.timeoutMs}ms`, retryable: true }));
      }, this.timeoutMs);

      this.pending.set(id, (response) => {
        clearTimeout(timer);
        if (response.error !== undefined) {
          resolve(err({ kind: "provider_error", message: `MCP ${method} failed: ${response.error.message ?? "no message"}`, retryable: false }));
          return;
        }
        resolve(ok(response.result));
      });

      this.proc?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }
}
