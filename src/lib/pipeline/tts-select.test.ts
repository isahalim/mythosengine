import { describe, expect, it, vi } from "vitest";
import { selectTtsDrivers, synthesizeWithFallback, type TtsSelection } from "./tts-select.ts";
import type { DriverError, TtsDriver, TtsRequest, TtsResponse } from "../drivers/types.ts";
import { err, ok, type Result } from "../result.ts";
import { QUOTAS } from "../../config/quotas.ts";
import type { GeminiTtsBudget } from "./tts-budget.ts";

const KEY = `AIza${"x".repeat(35)}`;

function response(marker: string): TtsResponse {
  return {
    audio: new Uint8Array([1, 2, 3]) as Uint8Array<ArrayBuffer>,
    mimeType: marker,
    wordTimings: [],
    quotaRemaining: null,
    tokensUsed: null,
  };
}

class StubTts implements TtsDriver {
  requests: TtsRequest[] = [];
  constructor(private readonly result: Result<TtsResponse, DriverError>) {}
  async synthesize(req: TtsRequest): Promise<Result<TtsResponse, DriverError>> {
    this.requests.push(req);
    return this.result;
  }
}

const GEMINI_REQUEST: TtsRequest = { text: "directed", voice: "Kore", styleDirection: "curious" };

/** A readable ledger with `spent` requests already recorded on the Pacific day named. */
function budget(spent: number, readable = true): GeminiTtsBudget {
  return { day: "2026-09-01", spent, budget: QUOTAS.gemini.ttsRequestsPerDayBudget, readable };
}
const EDGE_REQUEST: TtsRequest = { text: "plain", voice: "en-US-AriaNeural", rate: "+5%" };

describe("selectTtsDrivers", () => {
  const edge = new StubTts(ok(response("audio/mpeg")));

  it("offers no Gemini driver when no key is configured", () => {
    const selection = selectTtsDrivers(undefined, budget(0), edge);
    expect(selection.gemini).toBeNull();
    expect(selection.unavailableReason).toContain("GEMINI_API_KEY is not set");
  });

  it("offers Gemini when a key exists and the day's budget is untouched", () => {
    const selection = selectTtsDrivers(KEY, budget(0), edge);
    expect(selection.gemini).not.toBeNull();
    expect(selection.unavailableReason).toBeNull();
  });

  it("withholds Gemini once today's budget is spent, and says so with the numbers", () => {
    const spent = QUOTAS.gemini.ttsRequestsPerDayBudget;
    const selection = selectTtsDrivers(KEY, budget(spent), edge);
    expect(selection.gemini).toBeNull();
    expect(selection.unavailableReason).toContain(`${spent}/${spent}`);
    expect(selection.unavailableReason).toContain(String(QUOTAS.gemini.ttsRequestsPerDay));
  });

  it("withholds Gemini when the ledger could not be read, rather than assuming a fresh day", () => {
    const selection = selectTtsDrivers(KEY, { day: "2026-09-01", spent: 8, budget: 8, readable: false }, edge);
    expect(selection.gemini).toBeNull();
    expect(selection.unavailableReason).toContain("could not be read");
  });

  it("holds requests back rather than spending the full daily allowance", () => {
    // The point of the reserve: at the budget the pipeline stops, but the
    // provider would still accept more. That gap is what a re-run spends.
    expect(QUOTAS.gemini.ttsRequestsPerDayBudget).toBeLessThan(QUOTAS.gemini.ttsRequestsPerDay);
    expect(selectTtsDrivers(KEY, budget(QUOTAS.gemini.ttsRequestsPerDayBudget - 1), edge).gemini).not.toBeNull();
  });
});

describe("synthesizeWithFallback", () => {
  function selection(gemini: TtsDriver | null, edge: TtsDriver, unavailableReason: string | null = null): TtsSelection {
    return { gemini, edge, unavailableReason };
  }

  it("uses Gemini when it works, and reports no fallback", async () => {
    const gemini = new StubTts(ok(response("audio/wav")));
    const edge = new StubTts(ok(response("audio/mpeg")));
    const result = await synthesizeWithFallback(selection(gemini, edge), GEMINI_REQUEST, EDGE_REQUEST);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.driver).toBe("gemini-tts");
    expect(result.value.fallbackReason).toBeNull();
    expect(edge.requests).toHaveLength(0);
  });

  it("sends each driver its own request — the directed text never reaches Edge", async () => {
    const gemini = new StubTts(ok(response("audio/wav")));
    const edge = new StubTts(ok(response("audio/mpeg")));
    await synthesizeWithFallback(selection(gemini, edge), GEMINI_REQUEST, EDGE_REQUEST);
    expect(gemini.requests[0].text).toBe("directed");
  });

  it("falls back to Edge on a Gemini failure and records why, never silently", async () => {
    const gemini = new StubTts(err({ kind: "rate_limited", message: "RESOURCE_EXHAUSTED", retryable: true }));
    const edge = new StubTts(ok(response("audio/mpeg")));
    const log = vi.fn();

    const result = await synthesizeWithFallback(selection(gemini, edge), GEMINI_REQUEST, EDGE_REQUEST, log);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.driver).toBe("edge-tts");
    expect(result.value.fallbackReason).toContain("rate_limited");
    expect(result.value.fallbackReason).toContain("RESOURCE_EXHAUSTED");
    expect(log).toHaveBeenCalledOnce();
    // The Edge path gets the plain narration, not the bracketed direction.
    expect(edge.requests[0].text).toBe("plain");
  });

  it("carries the unavailable reason through when Gemini was never offered", async () => {
    const edge = new StubTts(ok(response("audio/mpeg")));
    const result = await synthesizeWithFallback(selection(null, edge, "GEMINI_API_KEY is not set"), GEMINI_REQUEST, EDGE_REQUEST);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.driver).toBe("edge-tts");
    expect(result.value.fallbackReason).toBe("GEMINI_API_KEY is not set");
  });

  it("fails the stage when Edge fails — there is nothing below it", async () => {
    const edge = new StubTts(err({ kind: "provider_error", message: "python3 missing", retryable: false }));
    const result = await synthesizeWithFallback(selection(null, edge), GEMINI_REQUEST, EDGE_REQUEST);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.message).toContain("python3 missing");
  });

  it("fails the stage when both fail, surfacing Edge's error as the terminal one", async () => {
    const gemini = new StubTts(err({ kind: "timeout", message: "gemini timed out", retryable: true }));
    const edge = new StubTts(err({ kind: "network", message: "edge unreachable", retryable: true }));
    const result = await synthesizeWithFallback(selection(gemini, edge), GEMINI_REQUEST, EDGE_REQUEST, () => {});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.message).toBe("edge unreachable");
  });
});
