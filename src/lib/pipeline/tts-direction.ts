import type { DiscourseBeat, DiscourseMove } from "./script-schema.ts";

/**
 * How each `move` should be delivered.
 *
 * These are stage directions, not adjectives for their own sake. Each one
 * describes what the host is *doing* at that moment in the argument, because
 * that is what a reader — human or model — can actually act on: "trying it
 * on" produces a different reading than "confident", and it is the reading
 * the beat's move implies.
 */
const MOVE_DIRECTION: Record<DiscourseMove, string> = {
  question: "genuinely curious, asking it for real",
  attempt: "trying the idea on, half-convinced",
  pushback: "catching herself, the doubt arriving mid-sentence",
  reframe: "slower, re-stating it now that she sees it",
  land: "quiet certainty, no triumph",
  open: "handing the question over, unresolved",
};

/**
 * The one flat direction used when per-beat direction is off.
 *
 * This is plan v2 §4's stated fallback — "if it does not [work], the
 * fallback is one flat style for the whole script, which is still
 * expressive, just not per-beat" — and it is a real code path rather than a
 * paragraph, because the per-beat behaviour is unmeasured (§9) and the thing
 * you cannot switch off is the thing you cannot test against.
 */
export const FLAT_DIRECTION = "Read this as one person thinking a question through out loud — curious, unhurried, arguing with herself rather than presenting to an audience.";

const PREAMBLE =
  "Read the following as a single speaker thinking out loud. Each line is preceded by a bracketed delivery note describing how she is saying it. Follow the notes; never read them aloud.";

export interface DirectedNarration {
  /** The style instruction sent as `TtsRequest.styleDirection`. */
  styleDirection: string;
  /** The text sent as `TtsRequest.text`. */
  text: string;
}

/**
 * Builds the single TTS request's input from the beats, carrying each beat's
 * `move` into it as inline direction.
 *
 * **This is the unmeasured half of plan v2** (§4, §9): whether inline
 * direction actually shifts delivery mid-utterance has not been tested
 * against the live API. `perBeat: false` is the measured-safe path and
 * produces exactly what Edge TTS would get — one style for the whole script,
 * the narration unchanged.
 *
 * The cost of being wrong is bounded and visible either way. If the notes are
 * ignored, the result is flat delivery — the same thing the Edge path gives.
 * If they were instead *read aloud*, the audio would contain the literal
 * words "curious, asking it for real", which is unmissable in review. What
 * must not happen is the bracketed notes reaching the caption track, and they
 * cannot: captions come from ALIGN over the audio, and `spokenText` below is
 * the note-free string the alignment is matched against.
 */
export function buildDirectedNarration(
  hook: string,
  beats: readonly DiscourseBeat[],
  openQuestion: string,
  perBeat: boolean,
): DirectedNarration {
  if (!perBeat) {
    return { styleDirection: FLAT_DIRECTION, text: spokenText(hook, beats, openQuestion) };
  }

  const lines = [
    `[${MOVE_DIRECTION.question}] ${hook}`,
    ...beats.map((beat) => `[${MOVE_DIRECTION[beat.move]}] ${beat.text}`),
    `[${MOVE_DIRECTION.open}] ${openQuestion}`,
  ];
  return { styleDirection: PREAMBLE, text: lines.join("\n") };
}

/**
 * The words that will actually be spoken, with no direction markup — the
 * string ALIGN matches Whisper's output against, and the string stored in
 * `scripts.body`.
 *
 * Kept identical to `flattenBeats` (discourse.ts) by construction: same
 * order, same separator. If these two ever disagree, beat boundaries land on
 * the wrong words and the footage cuts with them.
 */
function spokenText(hook: string, beats: readonly DiscourseBeat[], openQuestion: string): string {
  return [hook, ...beats.map((b) => b.text), openQuestion].map((s) => s.trim()).filter(Boolean).join(" ");
}

