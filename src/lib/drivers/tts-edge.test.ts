import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EdgeTtsDriver } from "./tts-edge.ts";

const fixturesDir = join(import.meta.dirname, "__fixtures__");
const fixture = (name: string) => join(fixturesDir, name);

const request = { text: "hello world", voice: "en-US-AndrewNeural" };

describe("EdgeTtsDriver", () => {
  it("returns audio bytes and word timings on success", async () => {
    const driver = new EdgeTtsDriver({ scriptPath: fixture("fake-edge-tts-success.py"), maxAttempts: 1 });
    const result = await driver.synthesize(request);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.audio.byteLength).toBeGreaterThan(0);
      expect(result.value.mimeType).toBe("audio/mpeg");
      expect(result.value.wordTimings).toEqual([
        { word: "hello", startMs: 100, endMs: 300 },
        { word: "world", startMs: 300, endMs: 550 },
      ]);
    }
  });

  it("fails cleanly, non-retryable, on malformed timings JSON", async () => {
    const driver = new EdgeTtsDriver({ scriptPath: fixture("fake-edge-tts-bad-json.py"), maxAttempts: 1 });
    const result = await driver.synthesize(request);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("invalid_response");
      expect(result.error.retryable).toBe(false);
    }
  });

  it("fails cleanly when the script exits 0 without writing output files", async () => {
    const driver = new EdgeTtsDriver({ scriptPath: fixture("fake-edge-tts-no-output.py"), maxAttempts: 1 });
    const result = await driver.synthesize(request);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid_response");
  });

  it("retries a transient (non-zero exit) failure then gives up as retryable", async () => {
    const driver = new EdgeTtsDriver({ scriptPath: fixture("fake-edge-tts-fail.py"), maxAttempts: 2 });
    const result = await driver.synthesize(request);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("network");
      expect(result.error.retryable).toBe(true);
    }
  });

  it("times out on a hanging subprocess and reports a retryable timeout", async () => {
    const driver = new EdgeTtsDriver({ scriptPath: fixture("fake-edge-tts-hang.py"), maxAttempts: 1, timeoutMs: 300 });
    const result = await driver.synthesize(request);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("timeout");
      expect(result.error.retryable).toBe(true);
    }
  }, 10_000);

  it("fails with a non-retryable provider_error when python3 itself can't be found", async () => {
    const driver = new EdgeTtsDriver({
      pythonBin: "definitely-not-a-real-interpreter-xyz",
      scriptPath: fixture("fake-edge-tts-success.py"),
      maxAttempts: 1,
    });
    const result = await driver.synthesize(request);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("provider_error");
      expect(result.error.retryable).toBe(false);
    }
  });
});
