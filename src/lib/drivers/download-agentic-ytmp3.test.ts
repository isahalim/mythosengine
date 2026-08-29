import { execSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AgenticYtmp3DownloadDriver } from "./download-agentic-ytmp3.ts";
import type { DriverError, LlmDriver, LlmRequest, LlmResponse, ToolCall } from "./types.ts";
import { ok, type Result } from "../result.ts";

function hasFfmpeg(): boolean {
  try {
    execSync("which ffmpeg && which ffprobe", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const TOOL_PAGE_HTML = `<!doctype html>
<html><body>
<input aria-label="YouTube URL" />
<button onclick="document.getElementById('real').style.display='inline'; document.getElementById('fake').style.display='inline'">Convert to MP4</button>
<a id="real" href="/real-video.mp4" download="video.mp4" style="display:none">Download MP4</a>
<a id="fake" href="/fake-video.mp4" download="video.mp4" style="display:none">Download Fake</a>
</body></html>`;

class ScriptedLlm implements LlmDriver {
  private i = 0;
  constructor(private readonly responses: LlmResponse[]) {}
  async complete(_req: LlmRequest): Promise<Result<LlmResponse, DriverError>> {
    const response = this.responses[this.i];
    this.i++;
    return ok(response ?? { content: "", finishReason: "stop", quotaRemaining: null, tokensUsed: null });
  }
}

function toolCallResponse(call: ToolCall): LlmResponse {
  return { content: "", finishReason: "tool_calls", quotaRemaining: null, tokensUsed: null, toolCalls: [call] };
}

/**
 * Scripts navigate → fill → click "Convert to MP4" → click the given
 * download link → wait_for_download → report_download, reading the real
 * saved-file path back out of browser_wait_for_download's own tool result
 * (the temp path isn't known ahead of time, so it can't be hardcoded into a
 * plain ScriptedLlm response the way the other drivers' tests can).
 */
class ReportingScriptedLlm implements LlmDriver {
  private step = 0;
  private lastDownloadPath = "";
  constructor(
    private readonly toolUrl: string,
    private readonly downloadLinkName: string,
  ) {}

  async complete(req: LlmRequest): Promise<Result<LlmResponse, DriverError>> {
    const lastTool = [...req.messages].reverse().find((m) => m.role === "tool");
    if (lastTool) {
      try {
        const parsed: unknown = JSON.parse(lastTool.content);
        if (typeof parsed === "object" && parsed !== null && typeof (parsed as { filePath?: unknown }).filePath === "string") {
          this.lastDownloadPath = (parsed as { filePath: string }).filePath;
        }
      } catch {
        // not JSON carrying a filePath — ignore
      }
    }

    const script: ToolCall[] = [
      { id: "1", name: "browser_navigate", argumentsJson: JSON.stringify({ url: this.toolUrl }) },
      { id: "2", name: "browser_fill", argumentsJson: JSON.stringify({ role: "textbox", name: "YouTube URL", value: "https://www.youtube.com/watch?v=abcd1234567" }) },
      { id: "3", name: "browser_click", argumentsJson: JSON.stringify({ role: "button", name: "Convert to MP4" }) },
      { id: "4", name: "browser_click", argumentsJson: JSON.stringify({ role: "link", name: this.downloadLinkName }) },
      { id: "5", name: "browser_wait_for_download", argumentsJson: "{}" },
      { id: "6", name: "report_download", argumentsJson: JSON.stringify({ filePath: this.lastDownloadPath }) },
    ];
    const call = script[Math.min(this.step, script.length - 1)];
    this.step++;
    return ok({ content: "", finishReason: "tool_calls", quotaRemaining: null, tokensUsed: null, toolCalls: [call] });
  }
}

describe.skipIf(!hasFfmpeg())("AgenticYtmp3DownloadDriver", () => {
  let dir: string;
  let realVideoPath: string;
  let server: Server;
  let toolUrl: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ytmp3-agentic-test-"));
    realVideoPath = join(dir, "real.mp4");
    execSync(`ffmpeg -y -f lavfi -i "testsrc=duration=3:size=320x240:rate=10" -c:v libx264 -pix_fmt yuv420p "${realVideoPath}"`, { stdio: "ignore" });
  });

  afterEach(() => {
    server?.close();
  });

  beforeEach(async () => {
    const realVideoBytes = await readFile(realVideoPath);
    server = createServer((req, res) => {
      if (req.url?.startsWith("/real-video.mp4")) {
        res.writeHead(200, { "content-type": "video/mp4" });
        res.end(realVideoBytes);
        return;
      }
      if (req.url?.startsWith("/fake-video.mp4")) {
        res.writeHead(200, { "content-type": "video/mp4" });
        res.end("this is not actually a video, just text pretending to be one");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(TOOL_PAGE_HTML);
    });
    toolUrl = await new Promise<string>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("expected a network address");
        resolve(`http://127.0.0.1:${address.port}/tools/converter`);
      });
    });
  });

  it("converts+downloads, validates the real file with ffprobe, and returns its measured duration", async () => {
    const driver = new AgenticYtmp3DownloadDriver({ llm: new ReportingScriptedLlm(toolUrl, "Download MP4"), toolUrl });

    const result = await driver.fetchVideo({ url: "https://www.youtube.com/watch?v=abcd1234567" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sourceVideoId).toBe("abcd1234567");
      expect(result.value.durationS).toBeGreaterThan(0);
      const bytes = await readFile(result.value.filePath);
      expect(bytes.length).toBeGreaterThan(0);
    }
  });

  it("refuses (policy_violation) a downloaded video longer than maxDurationS", async () => {
    const driver = new AgenticYtmp3DownloadDriver({ llm: new ReportingScriptedLlm(toolUrl, "Download MP4"), toolUrl });
    const result = await driver.fetchVideo({ url: "https://www.youtube.com/watch?v=abcd1234567", maxDurationS: 1 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("policy_violation");
      expect(result.error.retryable).toBe(false);
    }
  });

  it("rejects a downloaded file that isn't a real video, instead of trusting the agent's report", async () => {
    const driver = new AgenticYtmp3DownloadDriver({ llm: new ReportingScriptedLlm(toolUrl, "Download Fake"), toolUrl });
    const result = await driver.fetchVideo({ url: "https://www.youtube.com/watch?v=abcd1234567" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid_response");
  });

  it("fails with a retryable error when the agent reports it could not complete the download", async () => {
    const llm = new ScriptedLlm([
      toolCallResponse({ id: "1", name: "browser_navigate", argumentsJson: JSON.stringify({ url: toolUrl }) }),
      toolCallResponse({ id: "2", name: "report_download", argumentsJson: JSON.stringify({ filePath: "" }) }),
    ]);
    const driver = new AgenticYtmp3DownloadDriver({ llm, toolUrl });
    const result = await driver.fetchVideo({ url: "https://www.youtube.com/watch?v=abcd1234567" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("invalid_response");
      expect(result.error.retryable).toBe(true);
    }
  });

  it("refuses a URL that isn't a recognizable YouTube watch link, before ever opening a browser", async () => {
    const driver = new AgenticYtmp3DownloadDriver({ llm: new ScriptedLlm([]), toolUrl });
    const result = await driver.fetchVideo({ url: "https://not-youtube.example.com/whatever" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("invalid_response");
      expect(result.error.retryable).toBe(false);
    }
  });
});
