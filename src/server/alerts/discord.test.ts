import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { postAlert } from "./discord.ts";

describe("postAlert", () => {
  let server: Server;
  let baseUrl: string;
  let statusToReturn: number;
  let receivedBody: string | undefined;

  beforeEach(async () => {
    statusToReturn = 204;
    receivedBody = undefined;
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        receivedBody = raw;
        res.writeHead(statusToReturn);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected network address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(() => {
    server.close();
  });

  it("posts the message as Discord's expected JSON body", async () => {
    const result = await postAlert(baseUrl, "TTS driver failed 2 runs in a row");
    expect(result.ok).toBe(true);
    expect(JSON.parse(receivedBody ?? "{}")).toEqual({ content: "TTS driver failed 2 runs in a row" });
  });

  it("reports a non-retryable provider_error on a 4xx from Discord", async () => {
    statusToReturn = 400;
    const result = await postAlert(baseUrl, "hi");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("provider_error");
      expect(result.error.retryable).toBe(false);
    }
  });

  it("reports a retryable network error rather than throwing when the webhook is unreachable", async () => {
    const result = await postAlert("http://127.0.0.1:1", "hi");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.retryable).toBe(true);
  });
});
