import { describe, expect, it } from "vitest";
import { extractTags, isValidTag, malformedTags, sanitizeForSpeech, stripTags, VOCABULARY } from "./delivery-tags.ts";

describe("stripTags", () => {
  it("removes every bracketed note, valid or not", () => {
    expect(stripTags("[giggles] Nobody reads the patch notes. [a whole sentence that is not direction at all and runs on] Not one person.")).toBe(
      "Nobody reads the patch notes. Not one person.",
    );
  });

  it("leaves no double spaces behind, because an empty word shifts every beat boundary after it", () => {
    const stripped = stripTags("[excitedly] one [giggles] two [sighs] three");
    expect(stripped).toBe("one two three");
    expect(stripped.split(/\s+/).filter(Boolean)).toHaveLength(3);
    expect(stripped).not.toMatch(/ {2}/);
  });

  it("does not orphan punctuation when a tag sits before it", () => {
    expect(stripTags("She said it [laughs] , and meant it.")).toBe("She said it, and meant it.");
  });

  it("is a no-op on text that has no tags", () => {
    expect(stripTags("Nobody reads the patch notes.")).toBe("Nobody reads the patch notes.");
  });
});

describe("markdown emphasis", () => {
  it("keeps the word and drops the marks, on both paths", () => {
    // The first live run under the prompt that forbids these produced
    // `*actually*` anyway, and captions are burned in.
    expect(stripTags("do you *actually* swear by it")).toBe("do you actually swear by it");
    expect(stripTags("it **never** works, _ever_")).toBe("it never works, ever");
    expect(sanitizeForSpeech("[laughs] do you *actually* mean it")).toBe("[laughs] do you actually mean it");
  });

  it("leaves ordinary text with a stray asterisk alone rather than mangling it", () => {
    expect(stripTags("2 * 3 is six")).toBe("2 * 3 is six");
  });
});

describe("isValidTag", () => {
  it("accepts the whole documented vocabulary", () => {
    for (const list of Object.values(VOCABULARY)) {
      for (const tag of list) expect(isValidTag(tag), tag).toBe(true);
    }
  });

  it("accepts free-form direction of the right shape, because Gemini reads these as prose", () => {
    // A fixed allowlist would cap the product's range at whatever was typed
    // into this file. The fence is shape, not membership.
    expect(isValidTag("like a courtroom stenographer")).toBe(true);
    expect(isValidTag("sarcastically, one painfully slow word at a time")).toBe(true);
  });

  it("rejects a sentence the model put in the wrong place", () => {
    // Long, or punctuated like prose: either way Gemini would read it aloud.
    expect(isValidTag("she pauses here to let the moment land before continuing on to the next")).toBe(false);
    expect(isValidTag("wait. actually, no!")).toBe(false);
    expect(isValidTag("")).toBe(false);
  });
});

describe("sanitizeForSpeech", () => {
  it("keeps usable direction and drops the rest", () => {
    const out = sanitizeForSpeech("[giggles] Nobody reads them. [she gestures broadly at the entire concept of patch notes] Not one.");
    expect(out).toContain("[giggles]");
    expect(out).not.toContain("gestures");
    expect(out).toContain("Nobody reads them.");
  });

  it("names what it dropped, so a silent downgrade is still on the record", () => {
    expect(malformedTags("[giggles] a [she gestures at the whole idea of it, wearily and at length] b")).toEqual([
      "she gestures at the whole idea of it, wearily and at length",
    ]);
    expect(malformedTags("[giggles] a [sighs] b")).toEqual([]);
  });
});

describe("the safety property", () => {
  it("no tag survives into the caption path, whatever the writer wrote", () => {
    // The one thing this module exists for. A tag reaching the burned-in
    // captions is not a degraded video, it is a video with the word
    // "giggles" printed across it, and it cannot be un-shipped.
    const hostile = "[giggles][sighs] Text [ ] more [unclosed and then [nested] weird ] end [excitedly]";
    expect(stripTags(hostile)).not.toMatch(/[[\]]/);
    expect(extractTags(hostile).length).toBeGreaterThan(0);
  });
});
