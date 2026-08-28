import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { YoutubeUploadDriver } from "./upload-youtube.ts";

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

function defaultTokenHandler(_req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ access_token: "fake-access-token" }));
}

function consumeBody(req: IncomingMessage): Promise<void> {
  return new Promise((resolve) => {
    req.on("data", () => undefined);
    req.on("end", resolve);
  });
}

describe("YoutubeUploadDriver", () => {
  let mock: ReturnType<typeof startMockServer>;
  let videoDir: string;
  let videoPath: string;

  beforeEach(async () => {
    mock = startMockServer();
    videoDir = await mkdtemp(join(tmpdir(), "yt-upload-test-"));
    videoPath = join(videoDir, "video.mp4");
    await writeFile(videoPath, Buffer.from("fake mp4 bytes"));
  });

  afterEach(async () => {
    mock.server.close();
    await rm(videoDir, { recursive: true, force: true });
  });

  function makeDriver(uploadPath = "/upload") {
    return async () => {
      const base = await mock.baseUrl;
      return new YoutubeUploadDriver({
        clientId: "test-client",
        clientSecret: "test-secret",
        refreshToken: "test-refresh",
        tokenUrl: `${base}/token`,
        uploadUrl: `${base}${uploadPath}`,
        maxAttempts: 1,
      });
    };
  }

  const request = {
    filePath: "",
    title: "Test video",
    description: "desc",
    tags: ["a", "b"],
    containsSyntheticMedia: true as const,
  };

  it("completes the full flow: token refresh -> session init -> PUT upload -> video id", async () => {
    mock.routes.set("/token", defaultTokenHandler);
    mock.routes.set("/upload", async (req, res) => {
      await consumeBody(req);
      const base = await mock.baseUrl;
      res.writeHead(200, { location: `${base}/session/abc` });
      res.end();
    });
    mock.routes.set("/session/abc", async (req, res) => {
      await consumeBody(req);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "video123" }));
    });

    const driver = await (await makeDriver())();
    const result = await driver.publish({ ...request, filePath: videoPath });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.videoId).toBe("video123");
      expect(result.value.url).toBe("https://youtube.com/shorts/video123");
    }
  });

  it("fails cleanly when the token endpoint returns no access_token", async () => {
    mock.routes.set("/token", (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_grant" }));
    });
    const driver = await (await makeDriver())();
    const result = await driver.publish({ ...request, filePath: videoPath });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("invalid_response");
      expect(result.error.message).toContain("revoked");
    }
  });

  it("fails cleanly when the resumable session has no Location header", async () => {
    mock.routes.set("/token", defaultTokenHandler);
    mock.routes.set("/upload", async (req, res) => {
      await consumeBody(req);
      res.writeHead(200);
      res.end();
    });
    const driver = await (await makeDriver())();
    const result = await driver.publish({ ...request, filePath: videoPath });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("Location");
  });

  it("propagates a retryable failure from the PUT upload step", async () => {
    mock.routes.set("/token", defaultTokenHandler);
    mock.routes.set("/upload", async (req, res) => {
      await consumeBody(req);
      const base = await mock.baseUrl;
      res.writeHead(200, { location: `${base}/session/fail` });
      res.end();
    });
    mock.routes.set("/session/fail", async (req, res) => {
      await consumeBody(req);
      res.writeHead(500);
      res.end();
    });
    const driver = await (await makeDriver())();
    const result = await driver.publish({ ...request, filePath: videoPath });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("provider_error");
      expect(result.error.retryable).toBe(true);
    }
  });

  it("fails cleanly when the final video resource has no id", async () => {
    mock.routes.set("/token", defaultTokenHandler);
    mock.routes.set("/upload", async (req, res) => {
      await consumeBody(req);
      const base = await mock.baseUrl;
      res.writeHead(200, { location: `${base}/session/empty` });
      res.end();
    });
    mock.routes.set("/session/empty", async (req, res) => {
      await consumeBody(req);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({}));
    });
    const driver = await (await makeDriver())();
    const result = await driver.publish({ ...request, filePath: videoPath });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid_response");
  });
});
