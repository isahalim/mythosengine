import type { DiscourseBeat, BeatMove } from "./script-schema.ts";
import { sanitizeForSpeech, stripTags } from "./delivery-tags.ts";
import type { PerformancePlan } from "./performance.ts";

/**
 * How each `move` should be delivered.
 *
 * These are stage directions, not adjectives for their own sake. Each one
 * describes what the host is *doing* at that moment, because that is what a
 * reader — human or model — can actually act on: "trying it on" produces a
 * different reading than "confident", and it is the reading the move implies.
 *
 * Every move in the schema needs an entry, and the compiler enforces it. That
 * is the point of the `Record`: widening `BEAT_MOVES` for the new formats
 * broke this file immediately rather than shipping a video where a `verdict`
 * beat silently got no direction at all.
 */
const MOVE_DIRECTION: Record<BeatMove, string> = {
  question: "genuinely curious, asking it for real",
  attempt: "trying the idea on, half-convinced",
  pushback: "catching herself, the doubt arriving mid-sentence",
  reframe: "slower, re-stating it now that she sees it",
  land: "quiet certainty, no triumph",
  open: "handing the question over, unresolved",
  setup: "settling in, laying it out plainly",
  turn: "the moment it stops being the story she thought",
  escalation: "building, each one topping the last",
  evidence: "flat and factual, letting it do the work",
  verdict: "committed, no hedging",
  confession: "admitting it, slightly embarrassed",
  aside: "leaning in, off the record",
  punchline: "landing it and getting out",
};

/**
 * The one flat direction used when per-beat direction is off.
 *
 * A real code path rather than a paragraph, because per-beat delivery is the
 * unmeasured half of this design and the thing you cannot switch off is the
 * thing you cannot test against.
 */
const FLAT_DIRECTION = "Read this as one person thinking out loud — curious, unhurried, talking to one listener rather than presenting to an audience.";

const PREAMBLE =
  "Read the following as a single speaker. Bracketed notes are delivery direction and non-verbal sounds: perform them, never read them aloud. A note like [giggles] is a sound she makes; a note like [excitedly] describes how the words after it are said.";

export interface DirectedNarration {
  /** The style instruction sent as `TtsRequest.styleDirection`. */
  styleDirection: string;
  /** The text sent as `TtsRequest.text` — tags intact, for Gemini only. */
  text: string;
}

/**
 * Builds the Gemini TTS input: the writer's own inline tags, plus each
 * beat's `move` as an additional direction.
 *
 * **The safety property this file exists to hold.** Two strings come out of
 * one script. `text` here keeps every valid tag, because Gemini is the only
 * consumer that understands them. `spokenText` below strips all of them,
 * because it is what Edge TTS speaks, what ALIGN matches Whisper against,
 * what lands in `scripts.body`, and what is burned into the captions. A tag
 * leaking into that second string is not a degraded video, it is a video
 * with the word "giggles" printed across it, and it cannot be un-shipped.
 * Neither path trusts the writer to have placed tags correctly:
 * `sanitizeForSpeech` drops malformed ones, `stripTags` drops all of them.
 */
export function buildDirectedNarration(
  hook: string,
  beats: readonly DiscourseBeat[],
  openQuestion: string,
  perBeat: boolean,
  performance: PerformancePlan | null = null,
): DirectedNarration {
  if (!perBeat) {
    return { styleDirection: performance === null ? FLAT_DIRECTION : flatDirectionFor(performance), text: sanitizeForSpeech(spokenWithTags(hook, beats, openQuestion)) };
  }

  const lines = [
    `[${performance?.opening.tone ?? MOVE_DIRECTION.question}] ${hook}`,
    ...beats.map((beat) => `[${MOVE_DIRECTION[beat.move]}] ${beat.text}`),
    `[${performance?.closing.tone ?? MOVE_DIRECTION.open}] ${openQuestion}`,
  ];
  return { styleDirection: PREAMBLE, text: sanitizeForSpeech(lines.join("\n")) };
}

/**
 * The whole-utterance direction when per-beat notes are off but a
 * performance was rolled.
 *
 * Even on the flat path the arc is worth stating: the writer has already put
 * the tags in the text, and telling the voice what shape the video has helps
 * it honour them rather than averaging them out.
 */
function flatDirectionFor(performance: PerformancePlan): string {
  return [
    "Read this as one person talking to one listener, and perform the bracketed notes rather than reading them aloud.",
    `Open ${performance.opening.tone} and ${performance.opening.pace}; settle ${performance.middle.tone} through the middle; close ${performance.closing.tone} and ${performance.closing.pace}.`,
  ].join(" ");
}

/** Hook, beats, closing question — raw, tags and all. The Gemini path's input before sanitising. */
function spokenWithTags(hook: string, beats: readonly DiscourseBeat[], openQuestion: string): string {
  return [hook, ...beats.map((b) => b.text), openQuestion].map((s) => s.trim()).filter(Boolean).join(" ");
}

/**
 * The words that will actually be spoken, with no direction markup — the
 * string ALIGN matches Whisper's output against, the string Edge TTS
 * receives, and the string stored in `scripts.body`.
 *
 * Kept identical to `flattenBeats` (discourse.ts) by construction: same
 * order, same separator, same strip. If these two ever disagree, beat
 * boundaries land on the wrong words and the footage cuts with them.
 */
export function spokenText(hook: string, beats: readonly DiscourseBeat[], openQuestion: string): string {
  return stripTags(spokenWithTags(hook, beats, openQuestion));
}
