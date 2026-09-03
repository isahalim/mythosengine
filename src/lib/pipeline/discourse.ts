import type { DiscourseBeat, DiscourseScriptResponse } from "./script-schema.ts";
import { stripTags } from "./delivery-tags.ts";

/**
 * Words per minute the read-time estimate assumes.
 *
 * Edge TTS's neural voices at `+0%` sit near 150 wpm for ordinary prose;
 * this format is faster because the beats are short and clipped. 165 is a
 * deliberate midpoint, and it is only ever used to *estimate* — the real
 * duration comes from ffprobe after the render, and AUDIT SUMMARY compares
 * the two (see `computeAuditSummary`'s `narrationDurationS`). Nothing
 * downstream trusts this number; the gate below uses it to reject a script
 * that is wildly out of range before spending a TTS call on it.
 */
const WORDS_PER_MINUTE = 165;

/**
 * How far outside the requested duration a script may land and still pass.
 *
 * ±25% is wide on purpose. The estimate above is a single constant standing
 * in for delivery speed, pauses, and the operator's own `ttsRateRange`
 * directive, so a tight gate here would reject good scripts for a fault in
 * the ruler rather than in the script. It exists to catch the failure that
 * actually happens — a model asked for three minutes writing forty seconds
 * of copy — not to police a few seconds either way.
 */
const DURATION_TOLERANCE = 0.25;

/**
 * How many words a script written to `targetDurationS` should run to, and
 * the band around it that counts as on-target.
 *
 * Exported because AUDIT SUMMARY needs the identical answer: it flags a
 * script whose word count is out of range (`wordCountBounds` in audit.ts),
 * and a gate and a flag that disagree about the same script would be worse
 * than either alone. That file used to keep its own copy of the two
 * constants above with a comment claiming they were "one ruler" — they were
 * two, and nothing would have noticed them drifting apart.
 */
export function wordCountRange(targetDurationS: number): { target: number; min: number; max: number } {
  const target = (targetDurationS / 60) * WORDS_PER_MINUTE;
  return {
    target: Math.round(target),
    min: Math.round(target * (1 - DURATION_TOLERANCE)),
    max: Math.round(target * (1 + DURATION_TOLERANCE)),
  };
}

/**
 * Something worth telling the operator about a script — never a reason to
 * refuse one.
 *
 * **There is no longer a structural gate.** Until 2026-09-03 this type also
 * carried `no_pushback`, `no_land` and `pushback_out_of_position`, and a
 * script that tripped them was rejected outright: the format demanded that
 * the host be wrong before she was right, and a draft that went from
 * `attempt` to `land` was refused as "a lecture". Operator direction removed
 * it, and the reasoning is worth keeping. The rule could only ever describe
 * *one* shape. A story does not push back; a hot take concedes once and
 * carries on; an escalation has nothing to be wrong about. Enforcing the
 * discourse arc did not make scripts better, it made every script a
 * discourse — and it did so by throwing away finished renders, which is how
 * it came to be looked at (see performance.ts's `SCRIPT_FORMATS`, which is
 * what replaced it).
 *
 * What is left is length, and it is a guide rather than a gate — doubly so
 * now that scripts carry non-verbal sounds, which take real time in the
 * audio and none in the word count. A `[sighs]` is a beat of silence the
 * ruler below cannot see, so the estimate reads a shade long on every video
 * that uses them, and refusing a script on that basis would be refusing it
 * for a number we know to be wrong.
 */
export interface ScriptAdvisory {
  kind: "too_short" | "too_long";
  message: string;
}

function countWords(text: string): number {
  return stripTags(text).trim().split(/\s+/).filter(Boolean).length;
}

/** Every word the narration will actually speak, in order: hook, then beats, then the closing question. */
export function discourseWordCount(script: DiscourseScriptResponse): number {
  return countWords(flattenBeats(script));
}

/**
 * The narration text, as one string, in the order it is spoken.
 *
 * This is what goes to TTS and what lands in `scripts.body`, and those being
 * the same string is the point: every existing consumer of `body` — AUDIT
 * SUMMARY's near-duplicate check against recent scripts, the export package,
 * the console's review queue — keeps working unchanged, and none of them
 * needs to learn what a beat is.
 */
export function flattenBeats(script: DiscourseScriptResponse): string {
  return stripTags([script.hook, ...script.beats.map((b) => b.text), script.open_question].map((s) => s.trim()).filter(Boolean).join(" "));
}

export function estimatedReadSeconds(script: DiscourseScriptResponse): number {
  return (discourseWordCount(script) / WORDS_PER_MINUTE) * 60;
}

/**
 * What is worth saying about a finished draft. Advisory in full: this
 * function cannot fail a render, and nothing downstream treats its output as
 * a reason to.
 *
 * Both messages quote the word count to aim at, not only the seconds missed
 * by. A draft told just "118s is over the 113s ceiling" has to
 * reverse-engineer the ruler to know how much to cut, and the live
 * 2026-09-03 run shows what that costs: attempt one came back under the
 * floor, attempt two overshot the ceiling, and the stage died having never
 * been told the number it was aiming at.
 */
export function reviewScript(script: DiscourseScriptResponse, targetDurationS: number): ScriptAdvisory[] {
  const estimate = estimatedReadSeconds(script);
  const words = discourseWordCount(script);
  const range = wordCountRange(targetDurationS);
  const floor = targetDurationS * (1 - DURATION_TOLERANCE);
  const ceiling = targetDurationS * (1 + DURATION_TOLERANCE);

  if (estimate < floor) {
    return [
      {
        kind: "too_short",
        message: `estimated read time ${estimate.toFixed(0)}s is under the ${floor.toFixed(0)}s floor for a ${targetDurationS}s video: you wrote ${words} spoken words, aim for about ${range.target} (${range.min}-${range.max}). Get there with more beats, not longer ones`,
      },
    ];
  }
  if (estimate > ceiling) {
    return [
      {
        kind: "too_long",
        message: `estimated read time ${estimate.toFixed(0)}s is over the ${ceiling.toFixed(0)}s ceiling for a ${targetDurationS}s video: you wrote ${words} spoken words, aim for about ${range.target} (${range.min}-${range.max}). Cut beats, do not compress them`,
      },
    ];
  }
  return [];
}

/** The advisory list as one line a model can act on, for the rewrite in `generateDiscourseScript`. */
export function describeAdvisories(advisories: readonly ScriptAdvisory[]): string {
  return advisories.map((a) => `- ${a.message}`).join("\n");
}

/**
 * Where each beat starts and ends in the flattened narration, counted in
 * words.
 *
 * ALIGN turns these into timings (src/lib/pipeline/align.ts) by looking up
 * the same indices in the word sequence Whisper returns, and RENDER cuts
 * footage on the result. Counted here, against the same `flattenBeats`
 * output TTS was given, so the indices cannot drift from the audio.
 *
 * The hook occupies the words before the first beat and the closing question
 * the words after the last, which is why `startWord` does not begin at 0.
 */
export interface BeatWordRange {
  beatIndex: number;
  move: DiscourseBeat["move"];
  /** Inclusive index of the beat's first word in the flattened narration. */
  startWord: number;
  /** Exclusive index one past the beat's last word. */
  endWord: number;
}

export function beatWordRanges(script: DiscourseScriptResponse): BeatWordRange[] {
  let cursor = countWords(script.hook);
  return script.beats.map((beat, beatIndex) => {
    const length = countWords(beat.text);
    const range: BeatWordRange = { beatIndex, move: beat.move, startWord: cursor, endWord: cursor + length };
    cursor += length;
    return range;
  });
}
