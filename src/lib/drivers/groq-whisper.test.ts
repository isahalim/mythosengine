import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GroqWhisperDriver } from "./groq-whisper.ts";

describe("GroqWhisperDriver", () => {
  let server: Server;
  let baseUrl: string;
  let handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void;

  beforeEach(async () => {
    server = createServer((req, res) => handler(req, res));
    baseUrl = await new Promise<string>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("expected a network address");
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });
  });

  afterEach(() => {
    server.close();
  });

  const audioRequest = {
    source: { kind: "audio" as const, bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/wav" },
  };

  it("returns a transcript on success", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ text: "hello world", segments: [{ start: 0, end: 1, text: "hello world" }] }));
    };
    const driver = new GroqWhisperDriver({ apiKey: "test", baseUrl, maxAttempts: 1 });
    const result = await driver.transcribe(audioRequest);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.transcript).toBe("hello world");
  });

  it("rejects a youtube-id request — that belongs to yt-captions first", async () => {
    handler = () => {};
    const driver = new GroqWhisperDriver({ apiKey: "test", baseUrl, maxAttempts: 1 });
    const result = await driver.transcribe({ source: { kind: "youtube", videoId: "abc123" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.retryable).toBe(false);
  });

  it("fails cleanly on malformed JSON instead of throwing", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{not json");
    };
    const driver = new GroqWhisperDriver({ apiKey: "test", baseUrl, maxAttempts: 1 });
    const result = await driver.transcribe(audioRequest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid_response");
  });

  it("fails cleanly when the response has no text field", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ segments: [] }));
    };
    const driver = new GroqWhisperDriver({ apiKey: "test", baseUrl, maxAttempts: 1 });
    const result = await driver.transcribe(audioRequest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid_response");
  });

  it("asks for word granularity only when the caller wants it, and keeps segments alongside", async () => {
    let body = "";
    handler = (req, res) => {
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ text: "hello world", segments: [], words: [{ word: "hello", start: 0, end: 0.4 }, { word: "world", start: 0.4, end: 0.9 }] }));
      });
    };
    const driver = new GroqWhisperDriver({ apiKey: "test", baseUrl, maxAttempts: 1 });
    const result = await driver.transcribe({ ...audioRequest, wordTimestamps: true });

    expect(body).toContain("timestamp_granularities[]");
    expect(body).toContain("word");
    // Both granularities: asking for `word` alone drops `segments`, which
    // the transcript callers still read.
    expect(body).toContain("segment");
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.words).toEqual([
      { word: "hello", start: 0, end: 0.4 },
      { word: "world", start: 0.4, end: 0.9 },
    ]);
  });

  it("returns no words for a plain transcription, which never pays for them", async () => {
    let body = "";
    handler = (req, res) => {
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ text: "hello world", segments: [] }));
      });
    };
    const driver = new GroqWhisperDriver({ apiKey: "test", baseUrl, maxAttempts: 1 });
    const result = await driver.transcribe(audioRequest);
    expect(body).not.toContain("timestamp_granularities");
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.words).toEqual([]);
  });

  it("drops a word with no text rather than shifting every beat boundary after it", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ text: "hello world", words: [{ word: "hello", start: 0, end: 0.4 }, { start: 0.4, end: 0.5 }, { word: "world", start: 0.5, end: 0.9 }] }));
    };
    const driver = new GroqWhisperDriver({ apiKey: "test", baseUrl, maxAttempts: 1 });
    const result = await driver.transcribe({ ...audioRequest, wordTimestamps: true });
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.words.map((w) => w.word)).toEqual(["hello", "world"]);
  });
});
