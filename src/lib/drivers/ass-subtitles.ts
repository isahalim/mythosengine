import type { CaptionCue } from "./types.ts";

/**
 * Builds an ASS subtitle file from word/phrase-timed caption cues: bold,
 * high-contrast, centered, each cue fading in and out rather than a static
 * SRT box — matches the reference style in docs/DECISIONS.md's pivot entry.
 * A pure function on purpose (ARCHITECTURE.md §9's gate-testing philosophy):
 * fully testable without ever invoking ffmpeg.
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
Style: Caption,Arial,${fontSize},&H00FFFFFF,&H00000000,&H00000000,-1,0,1,4,0,5,60,60,${Math.round(videoHeight * 0.08)},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const lines = cues.map((cue) => {
    const start = formatAssTime(cue.startMs);
    const end = formatAssTime(cue.endMs);
    const text = escapeAssText(cue.text);
    return `Dialogue: 0,${start},${end},Caption,,0,0,0,,{\\fad(${fadeMs},${fadeMs})}${text}`;
  });

  return header + lines.join("\n") + "\n";
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
