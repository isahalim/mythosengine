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

/**
 * The filename extension Groq reads the audio format from.
 *
 * This is the whole reason this map exists, and it is not obvious: Groq (and
 * the OpenAI-compatible transcription API it mirrors) decides the format
 * from the **uploaded filename**, not from the multipart part's
 * Content-Type. Sending a perfectly good `audio/wav` blob under the name
 * "audio" is rejected with
 *
 *   file must be one of the following types: [flac mp3 mp4 mpeg mpga m4a ogg opus wav webm]
 *
 * which reads as "your format is unsupported" and means "I could not tell
 * what your format is". That failure took the first live RENDER on the
 * Gemini narration path (2026-08-31, run 33469903139) at ALIGN, after
 * RESEARCH, SCRIPT, CRITIC, FOOTAGE SELECT and TTS had all already
 * succeeded.
 *
 * Keys are what the drivers actually emit (`tts-gemini.ts` sends
 * `audio/wav`, `tts-edge.ts` MP3) plus the common aliases; values are the
 * extensions from the provider's own error message above.
 */
const EXTENSION_BY_MIME: Record<string, string> = {
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mpga": "mpga",
  "audio/mp4": "mp4",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/wav": "wav",
  "audio/wave": "wav",
  "audio/x-wav": "wav",
  "audio/webm": "webm",
};

/** Strips any `;codecs=...` parameter and normalises case before the lookup. */
function extensionForMime(mimeType: string): string | null {
  return EXTENSION_BY_MIME[mimeType.split(";")[0].trim().toLowerCase()] ?? null;
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

    // Refused here rather than sent and rejected: the provider's error for
    // an unrecognised format is about the *filename*, so it would point the
    // next reader at the wrong thing entirely. Naming the mime type this
    // driver was handed is the fact that actually helps.
    const extension = extensionForMime(req.source.mimeType);
    if (extension === null) {
      return err({
        kind: "policy_violation",
        message: `Groq Whisper cannot transcribe ${req.source.mimeType}; supported: ${[...new Set(Object.values(EXTENSION_BY_MIME))].join(", ")}`,
        retryable: false,
      });
    }

    const form = new FormData();
    form.set("model", this.model);
    form.set("response_format", "verbose_json");
    // The extension is load-bearing — see EXTENSION_BY_MIME. Not decoration.
    form.set("file", new Blob([req.source.bytes], { type: req.source.mimeType }), `audio.${extension}`);
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
