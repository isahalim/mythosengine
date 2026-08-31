import { describe, expect, it } from "vitest";
import { extractKeywords } from "./keywords.ts";

describe("extractKeywords", () => {
  it("ranks the hook's subject above a passing mention in the body", () => {
    const keywords = extractKeywords({
      hook: "Your city is watching you sleep.",
      body: "Councils bought the cameras quietly. A budget line, a procurement note, nothing anyone voted for.",
      debateQuestion: "Would you have voted for it?",
    });

    expect(keywords[0]).toBe("city");
    expect(keywords).toContain("watching");
  });

  it("drops stopwords and bare numbers", () => {
    const keywords = extractKeywords({
      hook: "It was the 2027 of them all.",
      body: "And then they were there, and it was over.",
    });

    expect(keywords).not.toContain("the");
    expect(keywords).not.toContain("2027");
    expect(keywords).not.toContain("it");
  });

  it("keeps a repeated adjacent pair as one phrase", () => {
    const keywords = extractKeywords({
      hook: "The surveillance camera never blinks.",
      body: "A surveillance camera on every corner, and a surveillance camera in every doorway.",
    });

    expect(keywords).toContain("surveillance camera");
  });

  it("does not keep a pair that appeared once in lowercase", () => {
    const keywords = extractKeywords({
      hook: "Quiet streets hide loud decisions.",
      body: "Nobody reads the minutes.",
    });

    expect(keywords.some((keyword) => keyword.includes(" "))).toBe(false);
  });

  it("treats a mid-sentence capitalized word as a proper noun, but not a sentence's first word", () => {
    const keywords = extractKeywords({
      hook: "Rockstar knows exactly what it is doing.",
      body: "Delays happen. Delays happen constantly. Everyone accepts delays now.",
    });

    // "Rockstar" opens the hook's sentence, so it gets no proper-noun bonus
    // and has to win on position alone — which the hook's weight gives it.
    expect(keywords[0]).toBe("rockstar");
  });

  it("keeps 'ai' despite the two-character floor", () => {
    const keywords = extractKeywords({ hook: "AI does not need your permission.", body: "It already has it." });

    expect(keywords).toContain("ai");
  });

  it("returns at most the requested number of keywords", () => {
    const keywords = extractKeywords(
      { hook: "One two three four five six seven.", body: "Eight nine ten eleven twelve thirteen fourteen." },
      3,
    );

    expect(keywords).toHaveLength(3);
  });

  it("returns nothing for a script with no content words", () => {
    expect(extractKeywords({ hook: "It is what it is.", body: "And they were." })).toEqual([]);
  });
});
