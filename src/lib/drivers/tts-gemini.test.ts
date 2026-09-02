import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GeminiTtsDriver, timeoutForText, wrapPcmInWav } from "./tts-gemini.ts";

/** 16-bit little-endian PCM, so an even byte count and a decodable header are both meaningful. */
const PCM = new Uint8Array([0x00, 0x01, 0xff, 0x7f, 0x10, 0x20]);
const PCM_B64 = Buffer.from(PCM).toString("base64");

describe("timeoutForText", () => {
  it("gives a real narration more time than it was measured to need", () => {
    // The 1,440-character script that timed out on 2026-09-02 synthesized in
    // 245.1s against a flat 120,000ms ceiling. Anything at or below that
    // measurement reintroduces the bug.
    const measuredMs = 245_100;
    expect(timeoutForText("x".repeat(1440))).toBeGreaterThan(measuredMs);
  });

  it("does not drop below the old floor for a short input", () => {
    // 48 words synthesized in 19.8s, so short inputs were never the problem
    // and must not become slower to fail.
    expect(timeoutForText("x".repeat(253))).toBe(120_000);
  });

  it("scales with length, because synthesis cost does", () => {
    expect(timeoutForText("x".repeat(3000))).toBeGreaterThan(timeoutForText("x".repeat(1500)));
  });

  it("covers the longest narration this system produces", () => {
    // A 180s script is ~450 words, ~2,700 characters.
    expect(timeoutForText("x".repeat(2700))).toBeGreaterThanOrEqual(1_080_000);
  });
});

describe("wrapPcmInWav", () => {
  it("writes a canonical 44-byte RIFF/WAVE header ahead of the samples", () => {
    const wav = wrapPcmInWav(PCM);
    const text = (start: number, length: number) => new TextDecoder().decode(wav.slice(start, start + length));
    const view = new DataView(wav.buffer);

    expect(wav.byteLength).toBe(44 + PCM.byteLength);
    expect(text(0, 4)).toBe("RIFF");
    expect(text(8, 4)).toBe("WAVE");
    expect(text(12, 4)).toBe("fmt ");
    expect(text(36, 4)).toBe("data");
    expect(view.getUint32(4, true)).toBe(36 + PCM.byteLength);
    expect(view.getUint16(20, true)).toBe(1); // uncompressed PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(24_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(PCM.byteLength);
  });

  it("derives byte rate and block align from the format, not from constants", () => {
    const view = new DataView(wrapPcmInWav(PCM, 48_000, 2, 16).buffer);
    expect(view.getUint16(32, true)).toBe(4); // 2 channels x 2 bytes
    expect(view.getUint32(28, true)).toBe(48_000 * 4);
  });

  it("copies the samples through byte-for-byte", () => {
    expect(wrapPcmInWav(PCM).slice(44)).toEqual(PCM);
  });
});

describe("GeminiTtsDriver", () => {
  let server: Server;
  let baseUrl: string;
  let handler: (req: IncomingMessage, res: ServerResponse) => void;
  let received: { headers: IncomingMessage["headers"]; body: Record<string, unknown> } | null;

  beforeEach(async () => {
    received = null;
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        received = { headers: req.headers, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} };
        handler(req, res);
      });
    });
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

  function driver() {
    return new GeminiTtsDriver({ apiKey: "test-key", baseUrl, maxAttempts: 1 });
  }

  function respond(payload: unknown, status = 200) {
    handler = (_req, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
  }

  const request = { text: "Nobody reads the patch notes.", voice: "Kore" };

  it("returns WAV-wrapped audio from the output_audio accessor", async () => {
    respond({ status: "completed", output_audio: { data: PCM_B64 } });
    const result = await driver().synthesize(request);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.mimeType).toBe("audio/wav");
    expect(new TextDecoder().decode(result.value.audio.slice(0, 4))).toBe("RIFF");
    expect(result.value.audio.slice(44)).toEqual(PCM);
  });

  it("finds the audio when it arrives as a step content part instead", async () => {
    respond({ status: "completed", steps: [{ type: "model_output", content: [{ type: "audio", data: PCM_B64, mime_type: "audio/L16;rate=24000" }] }] });
    const result = await driver().synthesize(request);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.audio.slice(44)).toEqual(PCM);
  });

  it("returns no word timings — Gemini has no WordBoundary, so the caller must run ALIGN", async () => {
    respond({ status: "completed", output_audio: { data: PCM_B64 } });
    const result = await driver().synthesize(request);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.wordTimings).toEqual([]);
  });

  it("sends one request for the whole script, with the voice in speech_config", async () => {
    respond({ status: "completed", output_audio: { data: PCM_B64 } });
    await driver().synthesize(request);
    expect(received?.headers["x-goog-api-key"]).toBe("test-key");
    expect(received?.body.response_format).toEqual({ type: "audio" });
    expect(received?.body.generation_config).toEqual({ speech_config: [{ voice: "Kore" }] });
    expect(received?.body.input).toBe("Nobody reads the patch notes.");
  });

  it("carries style direction inline in the input, which is the only place Gemini takes it", async () => {
    respond({ status: "completed", output_audio: { data: PCM_B64 } });
    await driver().synthesize({ ...request, styleDirection: "Read this as someone thinking out loud." });
    expect(received?.body.input).toBe("Read this as someone thinking out loud.\n\nNobody reads the patch notes.");
  });

  it("reports what it saw when the response carries no audio at all", async () => {
    respond({ status: "failed", steps: [{ type: "thought" }] });
    const result = await driver().synthesize(request);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.message).toContain("no audio payload");
    expect(result.error.message).toContain("steps=[thought]");
  });

  it("treats a zero-length payload as a retryable fault, not as silent audio", async () => {
    respond({ status: "completed", output_audio: { data: "" } });
    const result = await driver().synthesize(request);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.message).toContain("no audio payload");
  });

  it("fails cleanly on malformed JSON instead of throwing", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{not json");
    };
    const result = await driver().synthesize(request);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.kind).toBe("invalid_response");
  });

  it("surfaces the daily-quota 429 as a typed rate_limited error", async () => {
    respond({ error: { message: "RESOURCE_EXHAUSTED" } }, 429);
    const result = await driver().synthesize(request);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.kind).toBe("rate_limited");
  });

  it("sends exactly one request per synthesize, so the daily ledger cannot under-count", async () => {
    // The ledger (src/lib/pipeline/tts-budget.ts) records once per
    // synthesize() call. It was two attempts until 2026-09-02, so a failing
    // synthesis spent two of the ten daily requests while the KV entry
    // reported one — measured on that day's render, whose single "failed"
    // attempt took 243 seconds, which is two 120s timeouts.
    let calls = 0;
    handler = (_req, res) => {
      calls++;
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "boom" }));
    };
    await new GeminiTtsDriver({ apiKey: "test-key", baseUrl, baseDelayMs: 1 }).synthesize(request);
    expect(calls).toBe(1);
  });
});
