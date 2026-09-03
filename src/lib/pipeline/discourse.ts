import type { DiscourseBeat, DiscourseScriptResponse } from "./script-schema.ts";

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

export interface BeatStructureViolation {
  kind: "no_pushback" | "pushback_out_of_position" | "no_land" | "too_short" | "too_long";
  /**
   * Whether this violation may cost the day's video.
   *
   * `fatal` is the format itself — a script that never pushes back is the
   * lecture this format exists to replace, and shipping one would defeat
   * the point of having a gate. `advisory` is the length estimate, and it
   * is a different kind of claim entirely: `estimatedReadSeconds` is one
   * constant standing in for delivery speed, pauses and the operator's own
   * `ttsRateRange`, and this file's own comments say nothing downstream
   * trusts it. On 2026-09-03 that untrusted ruler killed a finished render
   * over `118s is over the 113s ceiling` — a 4% miss on an estimate,
   * against a real duration nobody had measured yet. A length miss earns a
   * rewrite; it does not get to throw away a script, a RESEARCH brief and
   * the day's video. AUDIT SUMMARY flags the same miss on the operator's
   * review surface, computed from the same ruler, where it belongs.
   */
  severity: "fatal" | "advisory";
  message: string;
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
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
  return [script.hook, ...script.beats.map((b) => b.text), script.open_question].map((s) => s.trim()).filter(Boolean).join(" ");
}

export function estimatedReadSeconds(script: DiscourseScriptResponse): number {
  return (discourseWordCount(script) / WORDS_PER_MINUTE) * 60;
}

/**
 * The format gate (plan v2 §4): **at minimum one `pushback` must sit between
 * an `attempt` and a `land`.**
 *
 * That ordering *is* the format. A script that goes straight from trying an
 * answer to declaring the payoff is a lecture — the exact thing the single
 * host was supposed to stop being when the second host was cut. With two
 * voices the disagreement was structural and free; with one, this check is
 * the only thing standing between "an argument" and "a monologue that sounds
 * like one".
 *
 * Note what is deliberately *not* checked. Moves may repeat, may skip, and
 * may appear before the `attempt` — a script that opens on two `question`
 * beats or reframes twice is fine. Over-specifying the shape here would make
 * the gate a template, and the model would spend its effort satisfying the
 * template rather than making the argument.
 *
 * Returns every violation rather than the first, so a repair retry can be
 * told everything wrong with the draft in one message instead of discovering
 * the faults one call at a time.
 */
export function validateBeatStructure(script: DiscourseScriptResponse, targetDurationS: number): BeatStructureViolation[] {
  const violations: BeatStructureViolation[] = [];
  const moves = script.beats.map((b) => b.move);

  const firstAttempt = moves.indexOf("attempt");
  const lastLand = moves.lastIndexOf("land");

  if (lastLand === -1) {
    violations.push({ kind: "no_land", severity: "fatal", message: "the script never lands — no beat has move 'land', so the argument has no payoff" });
  }

  const hasPushback = moves.includes("pushback");
  if (!hasPushback) {
    violations.push({
      kind: "no_pushback",
      severity: "fatal",
      message: "no beat has move 'pushback' — the host never catches the hole in her own answer, which makes this a lecture rather than a discourse",
    });
  } else if (firstAttempt !== -1 && lastLand !== -1) {
    // The rule is positional, not merely a presence check: a pushback after
    // the last land, or before the first attempt, has nothing to push back
    // against.
    const hasPushbackBetween = moves.some((move, i) => move === "pushback" && i > firstAttempt && i < lastLand);
    if (!hasPushbackBetween) {
      violations.push({
        kind: "pushback_out_of_position",
        severity: "fatal",
        message: `there is a 'pushback' beat but none of them sits between the first 'attempt' (beat ${firstAttempt + 1}) and the last 'land' (beat ${lastLand + 1}) — the host has to be wrong before she is right`,
      });
    }
  }

  // Both length messages quote the word counts, not only the seconds. A
  // draft told just "118s is over the 113s ceiling" has to reverse-engineer
  // the ruler to know how much to cut, and the live 2026-09-03 run shows
  // what that costs: attempt one came back under the floor, attempt two
  // overshot the ceiling, and the stage died having never been told the
  // number it was aiming at.
  const estimate = estimatedReadSeconds(script);
  const words = discourseWordCount(script);
  const range = wordCountRange(targetDurationS);
  const floor = targetDurationS * (1 - DURATION_TOLERANCE);
  const ceiling = targetDurationS * (1 + DURATION_TOLERANCE);
  if (estimate < floor) {
    violations.push({
      kind: "too_short",
      severity: "advisory",
      message: `estimated read time ${estimate.toFixed(0)}s is under the ${floor.toFixed(0)}s floor for a ${targetDurationS}s video: you wrote ${words} words, aim for about ${range.target} (${range.min}-${range.max}). Get there with more beats, not longer ones`,
    });
  } else if (estimate > ceiling) {
    violations.push({
      kind: "too_long",
      severity: "advisory",
      message: `estimated read time ${estimate.toFixed(0)}s is over the ${ceiling.toFixed(0)}s ceiling for a ${targetDurationS}s video: you wrote ${words} words, aim for about ${range.target} (${range.min}-${range.max}). Cut beats, do not compress them`,
    });
  }

  return violations;
}

/** The violation list as one line a model can act on, for the repair retry in `generateDiscourseScript`. */
export function describeViolations(violations: readonly BeatStructureViolation[]): string {
  return violations.map((v) => `- ${v.message}`).join("\n");
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
