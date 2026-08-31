import { EdgeTtsDriver } from "../drivers/tts-edge.ts";
import { createGeminiTtsDriverFromEnv } from "../drivers/resolve-gemini-driver.ts";
import type { DriverError, TtsDriver, TtsRequest, TtsResponse } from "../drivers/types.ts";
import type { Result } from "../result.ts";
import { QUOTAS } from "../../config/quotas.ts";

/** What `renders.tts_driver` records, and what the audit package reports. */
type TtsDriverName = "edge-tts" | "gemini-tts";

export interface TtsAttemptOutcome {
  driver: TtsDriverName;
  response: TtsResponse;
  /**
   * Why the narration is not on the driver the operator would have got,
   * or null when nothing was downgraded.
   *
   * Never null-and-silent on a fallback: §9 requires the audit package to
   * state the TTS settings actually used, and "which driver spoke, and why
   * not the other one" is the part a reviewer cannot reconstruct from the
   * audio.
   */
  fallbackReason: string | null;
}

export interface TtsSelection {
  /** Null when Gemini is unavailable — no key, or the daily budget is spent. */
  gemini: TtsDriver | null;
  edge: TtsDriver;
  /** Non-null whenever `gemini` is null: the reason, ready for the audit package. */
  unavailableReason: string | null;
}

/**
 * Which TTS drivers this render may use, and why.
 *
 * Two gates, in order. **A key must exist** — Gemini is optional
 * infrastructure, and a pipeline without `GEMINI_API_KEY` runs exactly as it
 * did before this driver existed. **The daily budget must not be spent** —
 * the free tier allows ten TTS requests per *day*, so the count that matters
 * is how many of today's renders already used Gemini, not how many this run
 * has made.
 *
 * `ttsRequestsPerDayBudget` (8, not 10) is the deliberate part: a render can
 * fail after synthesis — FFmpeg, export — and the operator re-runs it. Two
 * requests held back mean that re-run still gets the voice the first attempt
 * had, instead of silently arriving with a different narrator because the
 * budget ran out between attempts.
 */
export function selectTtsDrivers(
  geminiApiKey: string | undefined,
  geminiRendersToday: number,
  edge: TtsDriver = new EdgeTtsDriver(),
): TtsSelection {
  if (!geminiApiKey) {
    return { gemini: null, edge, unavailableReason: "GEMINI_API_KEY is not set — narration ran on the default Edge TTS path" };
  }
  const budget = QUOTAS.gemini.ttsRequestsPerDayBudget;
  if (geminiRendersToday >= budget) {
    return {
      gemini: null,
      edge,
      unavailableReason: `today's Gemini TTS budget is spent (${geminiRendersToday}/${budget} of the free tier's ${QUOTAS.gemini.ttsRequestsPerDay} daily requests) — narration fell back to Edge TTS`,
    };
  }
  return { gemini: createGeminiTtsDriverFromEnv(geminiApiKey), edge, unavailableReason: null };
}

/**
 * Synthesizes once, on the best available driver, and reports which one
 * actually spoke.
 *
 * A Gemini failure falls back to Edge rather than failing the render, and
 * that is a considered exception to "never return fallback data on failure"
 * (CLAUDE.md) rather than a hole in it. Nothing is swallowed: the error is
 * logged with its kind and message, the reason travels back to the caller in
 * `fallbackReason`, and it is written into the audit package the operator
 * reviews. The alternative — failing the whole render because the *optional*
 * upgrade was unavailable — would throw away a script, a research brief and a
 * claimed footage segment to avoid a less expressive voice.
 *
 * Edge failing is a real failure and is returned as one. There is nothing
 * below it.
 */
export async function synthesizeWithFallback(
  selection: TtsSelection,
  geminiRequest: TtsRequest,
  edgeRequest: TtsRequest,
  log: (message: string) => void = console.warn,
): Promise<Result<TtsAttemptOutcome, DriverError>> {
  if (selection.gemini !== null) {
    const result = await selection.gemini.synthesize(geminiRequest);
    if (result.ok) {
      return { ok: true, value: { driver: "gemini-tts", response: result.value, fallbackReason: null } };
    }
    log(`Gemini TTS failed (${result.error.kind}: ${result.error.message}) — falling back to Edge TTS.`);
    const edgeResult = await selection.edge.synthesize(edgeRequest);
    if (!edgeResult.ok) return edgeResult;
    return {
      ok: true,
      value: {
        driver: "edge-tts",
        response: edgeResult.value,
        fallbackReason: `Gemini TTS failed (${result.error.kind}: ${result.error.message})`,
      },
    };
  }

  const edgeResult = await selection.edge.synthesize(edgeRequest);
  if (!edgeResult.ok) return edgeResult;
  return { ok: true, value: { driver: "edge-tts", response: edgeResult.value, fallbackReason: selection.unavailableReason } };
}
