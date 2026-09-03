import { describe, expect, it } from "vitest";
import { describePerformance, rollPerformance, SCRIPT_FORMATS } from "./performance.ts";
import { isValidTag } from "./delivery-tags.ts";

describe("rollPerformance", () => {
  it("is deterministic in its seed, so a run can be reproduced from the audit package", () => {
    expect(rollPerformance("trace-a")).toEqual(rollPerformance("trace-a"));
  });

  it("actually varies across seeds — the whole reason it is a die and not a prompt", () => {
    const rolls = Array.from({ length: 60 }, (_, i) => rollPerformance(`trace-${i}`));
    expect(new Set(rolls.map((r) => r.format.id)).size).toBeGreaterThan(3);
    expect(new Set(rolls.map((r) => r.opening.tone)).size).toBeGreaterThan(3);
    expect(new Set(rolls.map((r) => r.closing.tone)).size).toBeGreaterThan(2);
    expect(new Set(rolls.map((r) => r.nonVerbal.join(","))).size).toBeGreaterThan(5);
  });

  it("always rolls laughter, because that is the sound that makes a listener believe there is a person", () => {
    for (let i = 0; i < 60; i++) {
      const roll = rollPerformance(`trace-${i}`);
      expect(roll.nonVerbal.some((cue) => cue.includes("laugh") || cue === "giggles" || cue === "chuckles")).toBe(true);
      expect(roll.nonVerbal.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps the energy shape on every roll — hook hard, warm middle, soft close", () => {
    // The die chooses each phase's flavour, never whether the phase exists:
    // the arc is a retention strategy, not a stylistic preference.
    for (let i = 0; i < 40; i++) {
      const roll = rollPerformance(`t${i}`);
      expect(roll.opening.tone).not.toBe("");
      expect(roll.middle.tone).not.toBe("");
      expect(roll.closing.tone).not.toBe("");
    }
  });

  it("keeps the character voice rare, so it reads as this video's idea and not the format's", () => {
    const withCharacter = Array.from({ length: 200 }, (_, i) => rollPerformance(`c${i}`)).filter((r) => r.stylistic !== null);
    expect(withCharacter.length).toBeGreaterThan(20);
    expect(withCharacter.length).toBeLessThan(90);
  });

  it("only ever rolls tags the speech path will actually accept", () => {
    for (let i = 0; i < 80; i++) {
      const roll = rollPerformance(`v${i}`);
      for (const tag of [roll.opening.tone, roll.opening.pace, roll.middle.tone, roll.closing.tone, roll.closing.pace, ...roll.nonVerbal]) {
        expect(isValidTag(tag), tag).toBe(true);
      }
      if (roll.stylistic !== null) expect(isValidTag(roll.stylistic)).toBe(true);
    }
  });
});

describe("describePerformance", () => {
  it("gives the writer the three phases, the sounds and the comedic device", () => {
    const text = describePerformance(rollPerformance("seed"));
    expect(text).toContain("OPEN HOT");
    expect(text).toContain("SETTLE INTO A SMILE");
    expect(text).toContain("LAND SOFT");
    expect(text).toContain("NON-VERBAL SOUNDS");
    expect(text).toContain("COMEDY");
  });

  it("names a real format with a real arc", () => {
    const roll = rollPerformance("seed");
    expect(SCRIPT_FORMATS.map((f) => f.id)).toContain(roll.format.id);
    expect(describePerformance(roll)).toContain(roll.format.premise);
  });
});
