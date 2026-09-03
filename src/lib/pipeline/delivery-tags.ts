/**
 * Gemini TTS inline delivery tags — the bracketed notes that tell the voice
 * *how* to say the next words, and the non-verbal sounds it makes on its own.
 *
 * Two rules govern everything in this file, and they are not symmetrical.
 *
 * **A tag may reach Gemini.** `TtsRequest.text` on the Gemini path carries
 * them, because that is the entire point: `[giggles] Nobody reads the patch
 * notes.` is a laugh and then a line, and no amount of style direction on the
 * whole utterance produces that.
 *
 * **A tag may never reach anything else.** Not Edge TTS, which has no notion
 * of them and would speak the word "giggles"; not `scripts.body`, which is
 * the near-duplicate corpus and the export package's script; and above all
 * not the caption track, which is burned into the video and cannot be taken
 * back. That guarantee comes from `stripTags` being applied on the way *out*
 * to every one of those consumers — never from trusting the writer to place
 * tags correctly. Safety here is subtractive: an unrecognised tag is still
 * stripped, so a model that invents `[whispering conspiratorially]` costs us
 * a delivery note, never a caption reading "whispering conspiratorially".
 *
 * Which is why validation below is deliberately permissive about *content*
 * and strict about *shape*. Gemini reads these as free-form direction — the
 * documented examples include `[like a deadpan sports commentator]` — so an
 * exact allowlist would cap the range of the product at whatever list was
 * typed here. `VOCABULARY` is therefore a menu shown to the writer, not a
 * fence; the fence is `TAG_SHAPE`, which keeps a tag short, single-line and
 * free of the punctuation that would mean the model is trying to smuggle
 * structure through.
 */

/**
 * What may sit between brackets and still be treated as delivery direction.
 *
 * Letters, digits, spaces and light punctuation, on one line. No sentence
 * punctuation: a tag is a stage direction, and a full stop or an exclamation
 * mark means the model is writing prose in the wrong place.
 */
const TAG_SHAPE = /^[\p{L}\p{N}][\p{L}\p{N} ,'’-]*$/u;

/**
 * The real discriminator between a stage direction and a stray sentence.
 *
 * Characters turned out to be the wrong ruler — "she gestures broadly at the
 * entire concept of patch notes" is 57 characters, comfortably inside any
 * limit generous enough for the vocabulary's own longest entry
 * ("sarcastically, one painfully slow word at a time", 47). Words separate
 * them cleanly: that entry is exactly 8, and every sentence a model has tried
 * to smuggle through has been 10 or more. This matters because an
 * over-long tag is the one failure mode with a real cost — Gemini reads a
 * stray sentence *aloud*, and it is then in the video.
 */
const MAX_TAG_WORDS = 8;
const MAX_TAG_CHARS = 60;

/** Any bracketed run, valid or not — what `stripTags` removes unconditionally. */
const ANY_TAG = /\[[^\]\n]*\]/g;

/**
 * Brackets left over after tag removal — an unclosed `[`, or a `]` whose
 * opener was eaten by an earlier match.
 *
 * Removed too, and unconditionally. `stripTags` promises that nothing
 * bracket-shaped reaches the burned-in captions, and "nothing except the
 * stray ones" is not a promise worth having.
 */
const ORPHAN_BRACKET = /[[\]]/g;

/**
 * Markdown emphasis markers around a word: `*actually*`, `**never**`,
 * `_this_`. The marks go; the word stays.
 *
 * Prompt rule 11 already forbids these, and the first live run under that
 * prompt produced `*actually*` and `*doesn't*` anyway. That is the whole
 * argument for handling it here as well: the captions are burned into the
 * video from this text, so a stray asterisk is printed on screen and cannot
 * be taken back, and Gemini would read the emphasis marks as words. A rule
 * the model follows most of the time is not a guarantee, and this is the
 * kind of defect that is only ever noticed after the render.
 */
const EMPHASIS = /(\*{1,3}|_{1,3})(?=\S)([^*_\n]+?)(?<=\S)\1/g;

function stripEmphasis(text: string): string {
  return text.replace(EMPHASIS, "$2");
}

/** True when `inner` (the text between the brackets) is usable delivery direction. */
export function isValidTag(inner: string): boolean {
  const trimmed = inner.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TAG_CHARS) return false;
  if (trimmed.split(/\s+/).length > MAX_TAG_WORDS) return false;
  return TAG_SHAPE.test(trimmed);
}

/**
 * The words that will actually be spoken, with every bracketed note removed.
 *
 * This is the string the captions are built from, the string Edge TTS is
 * handed, and the string stored in `scripts.body`. It is applied without
 * asking whether a tag was valid — a malformed tag is still not something a
 * viewer should read.
 *
 * Whitespace is renormalised afterwards because removing a tag leaves the
 * spaces that surrounded it, and a double space becomes an empty word in
 * `split(/\s+/)`, which would shift every beat's word range by one and take
 * the footage cuts with it.
 */
export function stripTags(text: string): string {
  return stripEmphasis(text)
    .replace(ANY_TAG, " ")
    .replace(ORPHAN_BRACKET, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .trim();
}

/** Every bracketed run in the text, brackets removed, in order of appearance. */
export function extractTags(text: string): string[] {
  return [...text.matchAll(ANY_TAG)].map((match) => match[0].slice(1, -1).trim());
}

/**
 * The text as Gemini should receive it: valid tags kept, malformed ones
 * removed along with the words they were not.
 *
 * The asymmetry with `stripTags` is the point. Both are applied to the same
 * raw beat text, and between them the same script becomes an expressive
 * performance on one path and clean readable words on the other, with no
 * chance of the two swapping.
 */
export function sanitizeForSpeech(text: string): string {
  // Kept tags are parked behind sentinels first, so the orphan-bracket sweep
  // below cannot eat the brackets of a tag this function just decided to
  // keep. The sentinels are control characters precisely because no script
  // will ever contain one.
  const OPEN = "\u0000";
  const CLOSE = "\u0001";
  return stripEmphasis(text)
    .replace(ANY_TAG, (match) => {
      const inner = match.slice(1, -1).trim();
      return isValidTag(inner) ? `${OPEN}${inner}${CLOSE}` : " ";
    })
    .replace(ORPHAN_BRACKET, " ")
    .replaceAll(OPEN, "[")
    .replaceAll(CLOSE, "]")
    .replace(/[ \t]+/g, " ")
    .replace(/ +\n/g, "\n")
    .trim();
}

/** Tags that appear in the text but are not usable direction — reported to the audit package, never spoken. */
export function malformedTags(text: string): string[] {
  return extractTags(text).filter((inner) => !isValidTag(inner));
}

/**
 * The vocabulary the writer is shown and the die rolls from
 * (Gemini's own "Commonly Used Inline Delivery Tags", plus the neighbours
 * each category obviously has).
 *
 * A menu, not a fence — `isValidTag` accepts anything of the right shape, so
 * a writer that reaches for a tone nobody listed here still gets it. What
 * these lists buy is a *distribution*: left to itself a model reaches for the
 * same two or three notes every time, and the whole reason this exists is
 * that every video should not sound like the last one.
 */
export const VOCABULARY = {
  /** Non-verbal sounds. Laughter first because it is the one that reads as a real person and not a narrator. */
  nonVerbal: ["giggles", "laughs", "chuckles", "soft laugh", "sighs", "gasp", "scoffs", "snorts", "crying", "sharp inhale", "clears throat", "cough"],
  emotion: ["excitedly", "curious", "amazed", "sarcastically", "serious", "bored", "reluctantly", "panicked", "tired", "warmly", "wistful", "incredulous", "conspiratorial"],
  vocal: ["whispers", "shouting", "asmr", "trembling", "monotone", "deep and loud shouting", "hushed", "breathy"],
  pacing: ["very fast", "very slow", "deliberate pause", "rushing", "drawn out", "sarcastically, one painfully slow word at a time"],
  stylistic: ["like a radio DJ", "like a deadpan sports commentator", "like a nature documentary narrator", "like telling a secret to a friend", "like reading a bedtime story", "like a courtroom closing argument"],
} as const;
