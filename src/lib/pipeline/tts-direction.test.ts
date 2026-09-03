import { describe, expect, it } from "vitest";
import { buildDirectedNarration, spokenText } from "./tts-direction.ts";
import { rollPerformance } from "./performance.ts";
import type { DiscourseBeat } from "./script-schema.ts";

const BEATS: DiscourseBeat[] = [
  { move: "setup", text: "[excitedly] Nobody reads the patch notes." },
  { move: "turn", text: "Except one person did. [giggles] One." },
  { move: "land", text: "[sighs] And that is the whole story." },
];

const HOOK = "[very fast] This took four years.";
const CLOSING = "[wistful] So who was it actually for?";

describe("the two strings one script becomes", () => {
  it("gives Gemini the tags, because it is the only driver that performs them", () => {
    const directed = buildDirectedNarration(HOOK, BEATS, CLOSING, false, rollPerformance("seed"));
    expect(directed.text).toContain("[giggles]");
    expect(directed.text).toContain("[excitedly]");
    expect(directed.text).toContain("[sighs]");
    expect(directed.text).toContain("Nobody reads the patch notes.");
  });

  it("gives everything else the words alone", () => {
    // This string is Edge TTS's input, ALIGN's reference, `scripts.body`,
    // and the burned-in captions. A tag reaching it cannot be un-shipped.
    const clean = spokenText(HOOK, BEATS, CLOSING);
    expect(clean).toBe("This took four years. Nobody reads the patch notes. Except one person did. One. And that is the whole story. So who was it actually for?");
    expect(clean).not.toMatch(/[[\]]/);
    expect(clean).not.toContain("giggles");
  });

  it("speaks the same words on both paths — only the direction differs", () => {
    const directed = buildDirectedNarration(HOOK, BEATS, CLOSING, false, rollPerformance("seed"));
    const clean = spokenText(HOOK, BEATS, CLOSING);
    // Strip the tags back out of the Gemini input and the two must agree, or
    // ALIGN is matching a transcript against words that were never spoken.
    expect(directed.text.replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim()).toBe(clean);
  });

  it("carries the rolled arc into the whole-utterance direction", () => {
    const roll = rollPerformance("seed");
    const directed = buildDirectedNarration(HOOK, BEATS, CLOSING, false, roll);
    expect(directed.styleDirection).toContain(roll.opening.tone);
    expect(directed.styleDirection).toContain(roll.middle.tone);
    expect(directed.styleDirection).toContain(roll.closing.tone);
  });

  it("drops a stray sentence the writer bracketed, rather than letting Gemini read it aloud", () => {
    const beats: DiscourseBeat[] = [{ move: "land", text: "[she gestures at the entire concept of patch notes, wearily] It is fine." }];
    const directed = buildDirectedNarration("Hook.", beats, "And?", false, rollPerformance("seed"));
    expect(directed.text).not.toContain("gestures");
    expect(directed.text).toContain("It is fine.");
  });

  it("gives every move a delivery note on the per-beat path, including the formats added after discourse", () => {
    const beats: DiscourseBeat[] = [
      { move: "verdict", text: "It was always going to end this way." },
      { move: "confession", text: "I believed the easy version too." },
      { move: "punchline", text: "Anyway." },
    ];
    const directed = buildDirectedNarration("Hook.", beats, "And?", true, rollPerformance("seed"));
    for (const line of directed.text.split("\n")) expect(line).toMatch(/^\[[^\]]+\] /);
  });
});
