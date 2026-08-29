import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgenticYoutubeSearchDriver } from "./youtube-search-agentic.ts";
import type { DriverError, LlmDriver, LlmRequest, LlmResponse, ToolCall } from "./types.ts";
import { ok, type Result } from "../result.ts";

const RESULTS_PAGE_HTML = `<!doctype html>
<html><body>
<a href="https://www.youtube.com/watch?v=abcd1234567">Real Walkthrough (25:00)</a>
<a href="https://evil.example.com/watch?v=zzzzzzzzzzz">A link that isn't actually youtube.com</a>
</body></html>`;

function startFixtureServer(): { server: Server; baseUrl: Promise<string> } {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(RESULTS_PAGE_HTML);
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

describe("AgenticYoutubeSearchDriver", () => {
  let fixture: ReturnType<typeof startFixtureServer>;
  let baseUrl: string;

  beforeEach(async () => {
    fixture = startFixtureServer();
    baseUrl = await fixture.baseUrl;
  });

  afterEach(() => {
    fixture.server.close();
  });

  it("reads real links off the results page and drops anything that isn't a real youtube.com/youtu.be watch URL", async () => {
    const llm = new ScriptedLlm([
      toolCallResponse({ id: "1", name: "browser_navigate", argumentsJson: JSON.stringify({ url: `${baseUrl}/results` }) }),
      toolCallResponse({ id: "2", name: "browser_list_links", argumentsJson: "{}" }),
      toolCallResponse({
        id: "3",
        name: "report_videos",
        argumentsJson: JSON.stringify({
          videos: [
            { url: "https://www.youtube.com/watch?v=abcd1234567", title: "Real Walkthrough", durationS: 1500, viewCount: 9000 },
            { url: "https://evil.example.com/watch?v=zzzzzzzzzzz", title: "Not actually youtube", durationS: 1500, viewCount: 1 },
          ],
        }),
      }),
    ]);

    const driver = new AgenticYoutubeSearchDriver({ llm, searchOrigin: baseUrl });
    const result = await driver.findTopLongFormVideos({ channelHandle: "SomeChannel", minDurationS: 1200, game: "Some Game" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([{ videoId: "abcd1234567", title: "Real Walkthrough", durationS: 1500, viewCount: 9000 }]);
    }
  });

  it("returns an empty list, not an error, when the model reports nothing usable", async () => {
    const llm = new ScriptedLlm([
      toolCallResponse({ id: "1", name: "browser_navigate", argumentsJson: JSON.stringify({ url: `${baseUrl}/results` }) }),
      toolCallResponse({ id: "2", name: "report_videos", argumentsJson: JSON.stringify({ videos: [] }) }),
    ]);

    const driver = new AgenticYoutubeSearchDriver({ llm, searchOrigin: baseUrl });
    const result = await driver.findTopLongFormVideos({ channelHandle: "SomeChannel", minDurationS: 1200 });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });

  it("propagates a driver error (e.g. the LLM call itself failing) as a typed Result, not a throw", async () => {
    const llm: LlmDriver = {
      async complete() {
        return { ok: false, error: { kind: "network", message: "connection refused", retryable: true } };
      },
    };

    const driver = new AgenticYoutubeSearchDriver({ llm, searchOrigin: baseUrl });
    const result = await driver.findTopLongFormVideos({ channelHandle: "SomeChannel", minDurationS: 1200 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("network");
  });
});
