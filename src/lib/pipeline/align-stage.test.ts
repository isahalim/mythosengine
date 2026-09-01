import { describe, expect, it } from "vitest";
import { resolveWordTimings } from "./align-stage.ts";
import type { AsrDriver, AsrResponse, DriverError, TtsWordTiming } from "../drivers/types.ts";
import { err, ok, type Result } from "../result.ts";
import type { BeatWordRange } from "./discourse.ts";

const BODY = "Everyone is wrong about this and the reason is simpler than it looks right now";
const WORDS = BODY.split(" ");

const beatRanges: BeatWordRange[] = [
  { beatIndex: 0, move: "question", startWord: 0, endWord: 7 },
  { beatIndex: 1, move: "land", startWord: 7, endWord: WORDS.length },
];

function asr(response: Result<AsrResponse, DriverError>): AsrDriver {
  return { transcribe: async () => response };
}

/** A transcript that matches the script word for word — what Whisper does with its own TTS audio. */
function perfectTranscript(): Result<AsrResponse, DriverError> {
  return ok({
    words: WORDS.map((word, i) => ({ word, start: i * 0.5, end: i * 0.5 + 0.4 })),
    transcript: BODY,
    segments: [],
    quotaRemaining: null,
    quotaResetAt: null,
  } as unknown as AsrResponse);
}

const base = {
  audio: new Uint8Array([1, 2, 3]) as Uint8Array<ArrayBuffer>,
  mimeType: "audio/wav",
  scriptBody: BODY,
  beatRanges,
  narrationDurationMs: 8_000,
};

const nativeTimings: TtsWordTiming[] = WORDS.map((word, i) => ({ word, startMs: i * 400, endMs: i * 400 + 350 }));

describe("resolveWordTimings", () => {
  it("uses the TTS driver's own timings and never calls the ASR at all", async () => {
    let called = false;
    const outcome = await resolveWordTimings({
      ...base,
      nativeTimings,
      asr: {
        transcribe: async () => {
          called = true;
          return err({ kind: "provider_error", message: "should not be reached", retryable: false });
        },
      },
    });

    expect(called).toBe(false);
    expect(outcome.captionTiming).toBe("native");
    expect(outcome.wordTimings).toEqual(nativeTimings);
    expect(outcome.failure).toBeNull();
  });

  it("force-aligns a transcript when the driver reported no timings", async () => {
    const outcome = await resolveWordTimings({ ...base, nativeTimings: [], asr: asr(perfectTranscript()) });

    expect(outcome.captionTiming).toBe("aligned");
    expect(outcome.alignMatchRatio).toBe(1);
    expect(outcome.failure).toBeNull();
    expect(outcome.wordTimings).toHaveLength(WORDS.length);
  });

  it("estimates rather than throwing when the transcription call fails", async () => {
    // The exact failure that killed a render on 2026-09-01: Groq rejecting
    // the upload's declared type. A complete narration, script and montage
    // were discarded for it.
    const outcome = await resolveWordTimings({
      ...base,
      nativeTimings: [],
      asr: asr(err({ kind: "invalid_response", message: "file must be one of the following types: [... wav ...]", retryable: false })),
    });

    expect(outcome.captionTiming).toBe("estimated");
    expect(outcome.failure).toEqual({ errorClass: "invalid_response", message: "file must be one of the following types: [... wav ...]" });
    expect(outcome.wordTimings).toHaveLength(WORDS.length);
    expect(outcome.alignMatchRatio).toBeNull();
  });

  it("estimates when the transcript is real but matches the script too poorly to trust", async () => {
    // Below ALIGN's 0.6 floor. Captions from a bad alignment drift in a way
    // you only find in review, so refusing it and saying so is right — but
    // refusing the whole video for it is not.
    const outcome = await resolveWordTimings({
      ...base,
      nativeTimings: [],
      asr: asr(
        ok({
          words: "totally different words that share nothing at all with it".split(" ").map((word, i) => ({ word, start: i, end: i + 0.5 })),
          transcript: "totally different",
          segments: [],
        } as unknown as AsrResponse),
      ),
    });

    expect(outcome.captionTiming).toBe("estimated");
    expect(outcome.failure?.errorClass).toBe("invalid_response");
  });

  it("estimates across the measured narration, so the captions end where the audio does", async () => {
    const outcome = await resolveWordTimings({
      ...base,
      narrationDurationMs: 12_345,
      nativeTimings: [],
      asr: asr(err({ kind: "timeout", message: "gone", retryable: true })),
    });

    expect(outcome.wordTimings[0].startMs).toBe(0);
    expect(outcome.wordTimings.at(-1)?.endMs).toBe(12_345);
  });

  it("keeps the script's own words, not the transcript's, on the estimated path", async () => {
    const outcome = await resolveWordTimings({
      ...base,
      nativeTimings: [],
      asr: asr(err({ kind: "rate_limited", message: "slow down", retryable: true })),
    });
    expect(outcome.wordTimings.map((t) => t.word)).toEqual(WORDS);
  });
});
