import { fetchWithRetry } from "./http.ts";
import type { DriverError, TtsDriver, TtsRequest, TtsResponse } from "./types.ts";
import { err, ok, type Result } from "../result.ts";

const GEMINI_INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";

/** Gemini TTS output is always raw, little-endian, 16-bit PCM at 24kHz mono (Google's own audio-format note). */
const SAMPLE_RATE = 24_000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;

interface GeminiAudioContent {
  type?: string;
  data?: string;
  mime_type?: string;
}

interface GeminiTtsResponse {
  status?: string;
  output_audio?: { data?: string; mime_type?: string };
  steps?: { type?: string; content?: GeminiAudioContent[] }[];
  usage?: { total_tokens?: number };
}

function isGeminiTtsResponse(value: unknown): value is GeminiTtsResponse {
  return typeof value === "object" && value !== null;
}

/**
 * The base64 audio payload, wherever the response chose to put it.
 *
 * The SDKs expose it as `interaction.output_audio.data`, which is a
 * convenience accessor; the underlying REST body may equally carry it as an
 * audio content part inside `steps[]`, the way text output does. Both are
 * checked rather than one being assumed, and a body with neither produces a
 * typed error naming what was actually there — a wrong guess here would
 * otherwise surface as a zero-byte narration track and a silent video.
 */
function extractAudioBase64(body: GeminiTtsResponse): string | null {
  if (typeof body.output_audio?.data === "string" && body.output_audio.data.length > 0) {
    return body.output_audio.data;
  }
  for (const step of body.steps ?? []) {
    for (const content of step.content ?? []) {
      if (typeof content.data === "string" && content.data.length > 0) return content.data;
    }
  }
  return null;
}

/**
 * A 44-byte canonical WAV header around the raw PCM.
 *
 * FFmpeg can be told to read headerless PCM with `-f s16le -ar 24000 -ac 1`,
 * but that pushes knowledge of this driver's sample format into the render
 * driver and into every future consumer of the audio file. Wrapping it here
 * means the rest of the pipeline sees an ordinary self-describing audio
 * file, exactly as it does from Edge TTS, and `narrationAudioPath` stays a
 * path rather than a path plus three flags.
 */
export function wrapPcmInWav(pcm: Uint8Array, sampleRate = SAMPLE_RATE, channels = CHANNELS, bitsPerSample = BITS_PER_SAMPLE): Uint8Array<ArrayBuffer> {
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const out = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(out.buffer);

  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i);
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true); // file size minus the 8-byte RIFF preamble
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk length
  view.setUint16(20, 1, true); // format 1 = uncompressed PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  ascii(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  out.set(pcm, 44);

  return out as Uint8Array<ArrayBuffer>;
}

export interface GeminiTtsDriverOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
}

/**
 * Gemini single-speaker TTS — the expressive *upgrade* over Edge TTS, never
 * the default (plan v2 §5, "Quota reality").
 *
 * Two facts govern every decision in this file.
 *
 * **One request per video, forced by quota.** The free tier allows 10 TTS
 * requests per *day*, total. Per-beat synthesis would cost one request per
 * beat, so a single 20-beat video would be twice the entire daily budget.
 * The whole script goes in one call and comes back as one audio file; the
 * per-beat expressiveness the format wants therefore has to travel *inside*
 * that one request, as inline style direction in the text (see
 * `src/lib/pipeline/tts-direction.ts`).
 *
 * **It returns no timings.** The word-level captions this system is built
 * around come entirely from Edge TTS's `WordBoundary` events, and Gemini has
 * no equivalent. `wordTimings` is therefore always `[]` here, and the caller
 * must run ALIGN (Groq Whisper, word granularity) to recover them. Returning
 * an empty array rather than throwing is deliberate — the contract in
 * `TtsResponse` says empty means "ask ALIGN" — but a caller that skips ALIGN
 * ships a video with no captions at all.
 *
 * Because it is the upgrade and not the default, its failure is not fatal:
 * `resolveTtsDriver` (src/lib/pipeline/tts-select.ts) falls back to Edge and
 * records that it did. That fallback is logged and written into the audit
 * package, never silent.
 */
/**
 * How long one synthesis may take, from the length of what it is speaking.
 *
 * **Measured, not assumed** (2026-09-02, `gemini-3.1-flash-tts-preview`,
 * live):
 *
 *   253 chars /  48 words ->  19.8s
 *   1,440 chars / 234 words -> 245.1s   <- a real render's narration
 *
 * Two things follow. Synthesis cost is **superlinear** in length — 0.41
 * s/word at 48 words, 1.05 s/word at 234 — so a constant chosen against a
 * short clip is not merely tight for a long one, it is out by multiples.
 * And the flat 120,000 that lived here was below the *measured* cost of an
 * ordinary script, so every full-length Gemini narration timed out, retried,
 * timed out again, and fell back to Edge after four minutes. The audit
 * package recorded the fallback honestly every time; nothing recorded that
 * the ceiling was the cause.
 *
 * 400ms per character is roughly 2.3x the slowest rate measured, which is
 * the right kind of margin for a ceiling whose only job is to catch a
 * genuinely dead request: too low and it discards work that would have
 * succeeded, too high and it costs one render one slow fallback. The floor
 * covers short inputs, where the per-character rate is least representative.
 *
 * A 180-second narration — the longest format this system produces — is
 * ~450 words, so this yields ~15 minutes of headroom for something measured
 * at ~8. `maxAttempts: 1` is what keeps that ceiling from ever being paid
 * twice.
 */
export function timeoutForText(text: string): number {
  const MS_PER_CHAR = 400;
  const FLOOR_MS = 120_000;
  return Math.max(FLOOR_MS, text.length * MS_PER_CHAR);
}

export class GeminiTtsDriver implements TtsDriver {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchImpl?: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;

  constructor(private readonly options: GeminiTtsDriverOptions) {
    this.baseUrl = options.baseUrl ?? GEMINI_INTERACTIONS_URL;
    this.model = options.model ?? "gemini-3.1-flash-tts-preview";
    this.fetchImpl = options.fetchImpl;
    // Derived per request, not a constant — see `timeoutForText`. A flat
    // 120_000 was here until 2026-09-02 and it silently cost every
    // full-length narration its voice.
    this.timeoutMs = options.timeoutMs ?? 0;
    // **One attempt.** It was two until 2026-09-02, "for a 5xx or a dropped
    // connection only", and that reasoning missed what the retry costs.
    //
    // The ledger (src/lib/pipeline/tts-budget.ts) records once per
    // `synthesize()` call, because that is where the caller can see it. A
    // driver that sends two requests per call therefore under-reports spend
    // against a budget of ten a day: the 2026-09-02 render's KV entry shows
    // one `failed` attempt for a synthesis that took 243 seconds, which is
    // two 120s timeouts and two real requests Google counted. A ledger that
    // is wrong about a ten-a-day quota is worse than no ledger, and
    // CLAUDE.md's rule is to count every request including the ones that
    // fail.
    //
    // Losing the retry costs little. `retryOn429` was already false, a
    // timeout is now nearly impossible (below), and the fallback is Edge
    // TTS with the reason recorded — never a failed render.
    this.maxAttempts = options.maxAttempts ?? 1;
    this.baseDelayMs = options.baseDelayMs ?? 1_000;
  }

  async synthesize(req: TtsRequest): Promise<Result<TtsResponse, DriverError>> {
    // Gemini's style control is prose in the input, not a parameter — the
    // documented form is literally "Say cheerfully: <text>".
    const input = req.styleDirection ? `${req.styleDirection}\n\n${req.text}` : req.text;

    const result = await fetchWithRetry(
      this.baseUrl,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": this.options.apiKey,
        },
        body: JSON.stringify({
          model: this.model,
          input,
          response_format: { type: "audio" },
          generation_config: { speech_config: [{ voice: req.voice }] },
        }),
      },
      {
        timeoutMs: this.timeoutMs > 0 ? this.timeoutMs : timeoutForText(input),
        maxAttempts: this.maxAttempts,
        baseDelayMs: this.baseDelayMs,
        fetchImpl: this.fetchImpl,
        // A 429 here is the ten-a-day ceiling, not a burst. It resets at
        // midnight Pacific and nothing this process can do moves it, so a
        // retry is a request that cannot succeed and is still counted —
        // which is how the 2026-09-02 render spent two of the ten to
        // discover the same thing twice.
        retryOn429: false,
      },
    );

    if (!result.ok) return result;

    let body: unknown;
    try {
      body = await result.value.json();
    } catch (cause) {
      return err({
        kind: "invalid_response",
        message: `malformed JSON from Gemini TTS: ${cause instanceof Error ? cause.message : String(cause)}`,
        retryable: false,
      });
    }

    if (!isGeminiTtsResponse(body)) {
      return err({ kind: "invalid_response", message: "Gemini TTS response was not an object", retryable: false });
    }

    const base64 = extractAudioBase64(body);
    if (base64 === null) {
      const seen = (body.steps ?? []).map((s) => s.type ?? "?").join(", ") || "none";
      return err({
        kind: "invalid_response",
        message: `Gemini TTS response carried no audio payload (status=${body.status ?? "?"}, steps=[${seen}])`,
        retryable: false,
      });
    }

    let pcm: Uint8Array;
    try {
      pcm = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    } catch (cause) {
      return err({
        kind: "invalid_response",
        message: `Gemini TTS audio payload was not valid base64: ${cause instanceof Error ? cause.message : String(cause)}`,
        retryable: false,
      });
    }

    if (pcm.byteLength === 0) {
      return err({ kind: "invalid_response", message: "Gemini TTS returned a zero-length audio payload", retryable: true });
    }

    return ok({
      audio: wrapPcmInWav(pcm),
      mimeType: "audio/wav",
      // Always empty — see the class comment. The caller runs ALIGN.
      wordTimings: [],
      quotaRemaining: null,
      tokensUsed: body.usage?.total_tokens ?? null,
    });
  }
}
