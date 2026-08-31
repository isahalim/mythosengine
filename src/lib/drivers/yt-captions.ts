import type { AsrDriver, AsrRequest, AsrResponse, DriverError } from "./types.ts";
import { err, ok, type Result } from "../result.ts";

/**
 * YouTube's public timedtext endpoint. No API key, but unofficial: YouTube
 * has tightened this over time and some videos need a signed `params` value
 * this driver does not attempt to derive. When that happens this returns a
 * "not_implemented"-shaped, non-retryable error — NORMALIZE (Phase 3) reads
 * that as "captions absent" and falls back to GroqWhisperDriver, exactly as
 * ARCHITECTURE.md §3 specifies.
 */
const TIMEDTEXT_URL = "https://www.youtube.com/api/timedtext";

interface TimedTextBody {
  events?: { tStartMs?: number; dDurationMs?: number; segs?: { utf8?: string }[] }[];
}

function isTimedTextBody(value: unknown): value is TimedTextBody {
  return typeof value === "object" && value !== null;
}

export interface YtCaptionsDriverOptions {
  lang?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class YtCaptionsDriver implements AsrDriver {
  private readonly lang: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: YtCaptionsDriverOptions = {}) {
    this.lang = options.lang ?? "en";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async transcribe(req: AsrRequest): Promise<Result<AsrResponse, DriverError>> {
    if (req.source.kind !== "youtube") {
      return err({
        kind: "invalid_response",
        message: "YtCaptionsDriver only accepts a youtube video id",
        retryable: false,
      });
    }

    const url = `${TIMEDTEXT_URL}?lang=${encodeURIComponent(this.lang)}&v=${encodeURIComponent(req.source.videoId)}&fmt=json3`;

    let res: Response;
    try {
      res = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (cause) {
      const isAbort = cause instanceof Error && cause.name === "TimeoutError";
      return err({
        kind: isAbort ? "timeout" : "network",
        message: cause instanceof Error ? cause.message : String(cause),
        retryable: true,
      });
    }

    if (!res.ok) {
      return err({ kind: "not_implemented", message: `no captions track (HTTP ${res.status})`, retryable: false });
    }

    const text = await res.text();
    if (text.trim() === "") {
      return err({ kind: "not_implemented", message: "empty captions track", retryable: false });
    }

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch (cause) {
      return err({
        kind: "invalid_response",
        message: `malformed captions JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
        retryable: false,
      });
    }

    if (!isTimedTextBody(body) || !body.events || body.events.length === 0) {
      return err({ kind: "not_implemented", message: "captions track had no events", retryable: false });
    }

    const segments = body.events
      .filter((e) => e.segs && e.segs.length > 0)
      .map((e) => ({
        start: (e.tStartMs ?? 0) / 1000,
        end: (e.tStartMs ?? 0) / 1000 + (e.dDurationMs ?? 0) / 1000,
        text: (e.segs ?? []).map((s) => s.utf8 ?? "").join(""),
      }));

    return ok({
      transcript: segments.map((s) => s.text).join(" ").trim(),
      segments,
      // YouTube's caption track is cue-level, not word-level. Empty rather
      // than approximated: ALIGN would rather have no timings than evenly
      // spaced guesses that look real.
      words: [],
      quotaRemaining: null,
      tokensUsed: null,
    });
  }
}
