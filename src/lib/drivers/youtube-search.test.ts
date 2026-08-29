import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { YoutubeDataApiSearchDriver } from "./youtube-search.ts";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

function startMockServer(): { server: Server; baseUrl: Promise<string>; routes: Map<string, Handler> } {
  const routes = new Map<string, Handler>();
  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    const handler = routes.get(path ?? "");
    if (!handler) {
      res.writeHead(404);
      res.end();
      return;
    }
    handler(req, res);
  });
  const baseUrl = new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("expected a network address");
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
  return { server, baseUrl, routes };
}

function jsonHandler(body: unknown): Handler {
  return (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
}

describe("YoutubeDataApiSearchDriver", () => {
  let mock: ReturnType<typeof startMockServer>;

  beforeEach(() => {
    mock = startMockServer();
  });

  afterEach(() => {
    mock.server.close();
  });

  async function makeDriver() {
    return new YoutubeDataApiSearchDriver({ apiKey: "test-key", apiBase: await mock.baseUrl, maxAttempts: 1 });
  }

  it("ranks eligible videos by view count, filtering out ones under minDurationS", async () => {
    mock.routes.set("/channels", jsonHandler({ items: [{ id: "chan1" }] }));
    mock.routes.set(
      "/search",
      jsonHandler({ items: [{ id: { videoId: "short1" } }, { id: { videoId: "long1" } }, { id: { videoId: "long2" } }] }),
    );
    mock.routes.set(
      "/videos",
      jsonHandler({
        items: [
          { id: "short1", snippet: { title: "A Short" }, contentDetails: { duration: "PT58S" }, statistics: { viewCount: "9999999" } },
          { id: "long1", snippet: { title: "Full Walkthrough Part 1" }, contentDetails: { duration: "PT2H10M" }, statistics: { viewCount: "500000" } },
          { id: "long2", snippet: { title: "Full Walkthrough Part 2" }, contentDetails: { duration: "PT1H45M" }, statistics: { viewCount: "800000" } },
        ],
      }),
    );

    const driver = await makeDriver();
    const result = await driver.findTopLongFormVideos({ channelHandle: "HollowPoiint", minDurationS: 1200 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // the Short is excluded entirely; the two long-form videos are ranked by viewCount, highest first
      expect(result.value.map((v) => v.videoId)).toEqual(["long2", "long1"]);
      expect(result.value[0].durationS).toBe(6300);
    }
  });

  it("returns an empty array (not an error) when no video meets minDurationS", async () => {
    mock.routes.set("/channels", jsonHandler({ items: [{ id: "chan1" }] }));
    mock.routes.set("/search", jsonHandler({ items: [{ id: { videoId: "short1" } }] }));
    mock.routes.set(
      "/videos",
      jsonHandler({ items: [{ id: "short1", snippet: { title: "A Short" }, contentDetails: { duration: "PT58S" }, statistics: { viewCount: "1" } }] }),
    );

    const driver = await makeDriver();
    const result = await driver.findTopLongFormVideos({ channelHandle: "HollowPoiint", minDurationS: 1200 });
    expect(result).toEqual({ ok: true, value: [] });
  });

  it("fails cleanly when the handle doesn't resolve to a channel", async () => {
    mock.routes.set("/channels", jsonHandler({ items: [] }));

    const driver = await makeDriver();
    const result = await driver.findTopLongFormVideos({ channelHandle: "NotARealHandle", minDurationS: 1200 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("invalid_response");
      expect(result.error.message).toContain("NotARealHandle");
    }
  });

  it("fails cleanly on malformed JSON from the API", async () => {
    mock.routes.set("/channels", (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{not json");
    });

    const driver = await makeDriver();
    const result = await driver.findTopLongFormVideos({ channelHandle: "HollowPoiint", minDurationS: 1200 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid_response");
  });

  it("fails cleanly when search.list responds with valid JSON that isn't an object", async () => {
    mock.routes.set("/channels", jsonHandler({ items: [{ id: "chan1" }] }));
    mock.routes.set("/search", jsonHandler(null));

    const driver = await makeDriver();
    const result = await driver.findTopLongFormVideos({ channelHandle: "HollowPoiint", minDurationS: 1200 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("search.list");
  });

  it("fails cleanly when videos.list responds with valid JSON that isn't an object", async () => {
    mock.routes.set("/channels", jsonHandler({ items: [{ id: "chan1" }] }));
    mock.routes.set("/search", jsonHandler({ items: [{ id: { videoId: "v1" } }] }));
    mock.routes.set("/videos", jsonHandler(null));

    const driver = await makeDriver();
    const result = await driver.findTopLongFormVideos({ channelHandle: "HollowPoiint", minDurationS: 1200 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("videos.list");
  });

  it("returns an empty array (no videos) when the channel has no videos at all", async () => {
    mock.routes.set("/channels", jsonHandler({ items: [{ id: "chan1" }] }));
    mock.routes.set("/search", jsonHandler({ items: [] }));

    const driver = await makeDriver();
    const result = await driver.findTopLongFormVideos({ channelHandle: "HollowPoiint", minDurationS: 1200 });
    expect(result).toEqual({ ok: true, value: [] });
  });
});
