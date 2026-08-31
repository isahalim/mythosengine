import type { CaptionCue } from "./types.ts";

/** ASS colours are &HAABBGGRR — blue-green-red, not the RGB order everything else uses. */
const WHITE = "&H00FFFFFF";
/** The accent applied to the word being spoken and to keyword words. A warm amber (#FFC24B) in BGR order. */
const ACCENT = "&H004BC2FF";

/**
 * Builds an ASS subtitle file from word/phrase-timed caption cues: bold,
 * high-contrast, centered, each cue fading in and out rather than a static
 * SRT box — matches the reference style in docs/DECISIONS.md's pivot entry.
 * A pure function on purpose (ARCHITECTURE.md §9's gate-testing philosophy):
 * fully testable without ever invoking ffmpeg.
 *
 * A cue carrying `words` is rendered word-by-word: one event per word's
 * span, showing the whole cue with the spoken word in the accent colour.
 * That is deliberately not ASS karaoke (`\k`) — karaoke timing is expressed
 * in centiseconds relative to the line start, which rounds, drifts over a
 * long cue, and interacts badly with the fade this style already uses.
 * Emitting the states explicitly costs a few more lines in a file nobody
 * reads and makes the output exactly what the timings say.
 */
export function buildAssSubtitles(cues: CaptionCue[], videoWidth: number, videoHeight: number): string {
  const fontSize = Math.round(videoHeight * 0.045);
  const fadeMs = 80;

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${videoWidth}
PlayResY: ${videoHeight}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,Arial,${fontSize},${WHITE},&H00000000,&H00000000,-1,0,1,4,0,5,60,60,${Math.round(videoHeight * 0.08)},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const lines = cues.flatMap((cue) => renderCue(cue, fadeMs));
  return header + lines.join("\n") + "\n";
}

function renderCue(cue: CaptionCue, fadeMs: number): string[] {
  const keywords = new Set((cue.keywords ?? []).map(normalize));

  if (!cue.words || cue.words.length === 0) {
    return [dialogue(cue.startMs, cue.endMs, `{\\fad(${fadeMs},${fadeMs})}${highlightText(cue.text, keywords)}`)];
  }

  const words = cue.words;
  return words.map((word, i) => {
    const text = highlightKeywords(words.map((w) => w.text), keywords, i);
    // Only the first and last states fade, so the cue fades in once and out
    // once rather than flickering on every word.
    const fade = i === 0 ? `{\\fad(${fadeMs},0)}` : i === words.length - 1 ? `{\\fad(0,${fadeMs})}` : "";
    // Each state runs until the next word starts, so there is no gap between
    // them even when the speaker pauses mid-cue.
    const end = i === words.length - 1 ? cue.endMs : words[i + 1].startMs;
    return dialogue(word.startMs, end, `${fade}${text}`);
  });
}

/**
 * Free text with its keywords accented, preserving the original whitespace.
 *
 * Split-and-rejoin on `/\s+/` would be simpler and would silently turn a
 * newline into a space, collapsing a deliberately two-line cue into one.
 * Capturing the separators keeps them — `escapeAssText` then renders a
 * newline as ASS's own `\N` break.
 */
function highlightText(text: string, keywords: ReadonlySet<string>): string {
  return text
    .split(/(\s+)/)
    .map((token, i) => {
      if (i % 2 === 1 || token.length === 0) return escapeAssText(token); // odd indices are the captured separators
      return keywords.has(normalize(token)) ? accent(token) : escapeAssText(token);
    })
    .join("");
}

function accent(word: string): string {
  return `{\\c${ACCENT}}${escapeAssText(word)}{\\c${WHITE}}`;
}

/**
 * The cue's words as one ASS string, with the spoken word and any keywords
 * in the accent colour.
 *
 * The colour is re-set to white after every accented word rather than
 * relying on ASS's own scoping, because override tags persist to the end of
 * the line — leaving it unset would paint the entire remainder of the cue.
 */
function highlightKeywords(words: readonly string[], keywords: ReadonlySet<string>, activeIndex: number): string {
  return words
    .map((word, i) => {
      const accented = i === activeIndex || keywords.has(normalize(word));
      return accented ? accent(word) : escapeAssText(word);
    })
    .join(" ");
}

function normalize(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
}

function dialogue(startMs: number, endMs: number, text: string): string {
  return `Dialogue: 0,${formatAssTime(startMs)},${formatAssTime(endMs)},Caption,,0,0,0,,${text}`;
}

function formatAssTime(ms: number): string {
  const totalCentiseconds = Math.round(ms / 10);
  const centiseconds = totalCentiseconds % 100;
  const totalSeconds = Math.floor(totalCentiseconds / 100);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}:${pad(minutes)}:${pad(seconds)}.${pad(centiseconds)}`;
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function escapeAssText(text: string): string {
  // ASS treats \, {, } specially; escape braces so cue text can never inject
  // override tags, and turn literal newlines into ASS's own line-break code.
  return text.replace(/\\/g, "\\\\").replace(/[{}]/g, (m) => (m === "{" ? "\\{" : "\\}")).replace(/\n/g, "\\N");
}
