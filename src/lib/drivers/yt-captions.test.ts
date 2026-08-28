import { describe, expect, it } from "vitest";
import { YtCaptionsDriver } from "./yt-captions.ts";

function fakeFetch(response: Response): typeof fetch {
  return (async () => response.clone()) as typeof fetch;
}

describe("YtCaptionsDriver", () => {
  it("parses a captions track into a transcript", async () => {
    const body = JSON.stringify({
      events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "hello " }, { utf8: "world" }] }],
    });
    const driver = new YtCaptionsDriver({ fetchImpl: fakeFetch(new Response(body, { status: 200 })) });
    const result = await driver.transcribe({ source: { kind: "youtube", videoId: "abc123" } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.transcript).toBe("hello world");
  });

  it("reports not_implemented (non-retryable) when no track exists, so callers fall back to Whisper", async () => {
    const driver = new YtCaptionsDriver({ fetchImpl: fakeFetch(new Response("", { status: 404 })) });
    const result = await driver.transcribe({ source: { kind: "youtube", videoId: "abc123" } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("not_implemented");
      expect(result.error.retryable).toBe(false);
    }
  });

  it("reports not_implemented on an empty body", async () => {
    const driver = new YtCaptionsDriver({ fetchImpl: fakeFetch(new Response("", { status: 200 })) });
    const result = await driver.transcribe({ source: { kind: "youtube", videoId: "abc123" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("not_implemented");
  });

  it("reports a retryable network error when fetch itself throws", async () => {
    const driver = new YtCaptionsDriver({
      fetchImpl: (async () => {
        throw new Error("dns failure");
      }) as typeof fetch,
    });
    const result = await driver.transcribe({ source: { kind: "youtube", videoId: "abc123" } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("network");
      expect(result.error.retryable).toBe(true);
    }
  });

  it("reports invalid_response on malformed JSON", async () => {
    const driver = new YtCaptionsDriver({ fetchImpl: fakeFetch(new Response("{not json", { status: 200 })) });
    const result = await driver.transcribe({ source: { kind: "youtube", videoId: "abc123" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid_response");
  });

  it("reports not_implemented when the track has zero events", async () => {
    const driver = new YtCaptionsDriver({
      fetchImpl: fakeFetch(new Response(JSON.stringify({ events: [] }), { status: 200 })),
    });
    const result = await driver.transcribe({ source: { kind: "youtube", videoId: "abc123" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("not_implemented");
  });

  it("rejects an audio-source request — that belongs to Whisper directly", async () => {
    const driver = new YtCaptionsDriver({ fetchImpl: fakeFetch(new Response("{}")) });
    const result = await driver.transcribe({ source: { kind: "audio", bytes: new Uint8Array(), mimeType: "audio/wav" } });
    expect(result.ok).toBe(false);
  });
});
