import { fetchWithRetry } from "./http.ts";
import type { AsrDriver, AsrRequest, AsrResponse, DriverError } from "./types.ts";
import { err, ok, type Result } from "../result.ts";

const GROQ_TRANSCRIPTIONS_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

interface GroqTranscriptionResponse {
  text?: string;
  segments?: { start?: number; end?: number; text?: string }[];
  words?: { word?: string; start?: number; end?: number }[];
}

function isGroqTranscriptionResponse(value: unknown): value is GroqTranscriptionResponse {
  return typeof value === "object" && value !== null;
}

export interface GroqWhisperDriverOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
}

/** Groq Whisper ASR driver — fallback for when yt-captions has no transcript. */
export class GroqWhisperDriver implements AsrDriver {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchImpl?: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;

  constructor(private readonly options: GroqWhisperDriverOptions) {
    this.baseUrl = options.baseUrl ?? GROQ_TRANSCRIPTIONS_URL;
    this.model = options.model ?? "whisper-large-v3";
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = options.timeoutMs ?? 30_000; // audio uploads are slower than chat completions
    this.maxAttempts = options.maxAttempts ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 500;
  }

  async transcribe(req: AsrRequest): Promise<Result<AsrResponse, DriverError>> {
    if (req.source.kind !== "audio") {
      return err({
        kind: "invalid_response",
        message: "GroqWhisperDriver only accepts audio bytes; route youtube ids through yt-captions first",
        retryable: false,
      });
    }

    const form = new FormData();
    form.set("model", this.model);
    form.set("response_format", "verbose_json");
    form.set("file", new Blob([req.source.bytes], { type: req.source.mimeType }), "audio");
    if (req.wordTimestamps) {
      // Both granularities, appended rather than set: asking for `word`
      // alone makes the provider drop `segments` from the response, and the
      // existing transcript callers read those. Appending twice is how a
      // repeated field is expressed in multipart form data.
      form.append("timestamp_granularities[]", "segment");
      form.append("timestamp_granularities[]", "word");
    }

    const result = await fetchWithRetry(
      this.baseUrl,
      {
        method: "POST",
        headers: { authorization: `Bearer ${this.options.apiKey}` },
        body: form,
      },
      {
        timeoutMs: this.timeoutMs,
        maxAttempts: this.maxAttempts,
        baseDelayMs: this.baseDelayMs,
        fetchImpl: this.fetchImpl,
      },
    );

    if (!result.ok) return result;

    let body: unknown;
    try {
      body = await result.value.json();
    } catch (cause) {
      return err({
        kind: "invalid_response",
        message: `malformed JSON from Groq Whisper: ${cause instanceof Error ? cause.message : String(cause)}`,
        retryable: false,
      });
    }

    if (!isGroqTranscriptionResponse(body) || typeof body.text !== "string") {
      return err({ kind: "invalid_response", message: "Groq Whisper response had no text field", retryable: false });
    }

    return ok({
      transcript: body.text,
      segments: (body.segments ?? []).map((s) => ({ start: s.start ?? 0, end: s.end ?? 0, text: s.text ?? "" })),
      // Words with no text are dropped rather than defaulted to "": an empty
      // word would occupy a position in the sequence ALIGN matches the
      // script against, and shift every beat boundary after it.
      words: (body.words ?? []).flatMap((w) => (typeof w.word === "string" && w.word.length > 0 ? [{ word: w.word, start: w.start ?? 0, end: w.end ?? 0 }] : [])),
      quotaRemaining: null,
      tokensUsed: null,
    });
  }
}
