import { describe, expect, it } from "vitest";
import { pickGamesForToday, pickVoicesForToday, preferUnusedToday, weightSourcesForToday } from "./diversity.ts";

describe("preferUnusedToday", () => {
  it("puts unused candidates first when diversityMode is on", () => {
    expect(preferUnusedToday(["a", "b", "c"], ["a"], true)).toEqual(["b", "c"]);
  });

  it("returns candidates unchanged when diversityMode is off, even if some were used today", () => {
    expect(preferUnusedToday(["a", "b", "c"], ["a"], false)).toEqual(["a", "b", "c"]);
  });

  it("falls back to the full candidate list when everything has already been used today", () => {
    expect(preferUnusedToday(["a", "b"], ["a", "b"], true)).toEqual(["a", "b"]);
  });
});

describe("pickGamesForToday", () => {
  it("a fixture day with 2 already-used games excludes them from the 3rd pick's front-of-list, when diversity_mode is on", () => {
    const eligible = ["minecraft", "gta-v", "subway-surfers", "fortnite"];
    const usedToday = ["minecraft", "gta-v"];
    expect(pickGamesForToday(eligible, usedToday, true)).toEqual(["subway-surfers", "fortnite"]);
  });

  it("does not exclude already-used games when diversity_mode is off", () => {
    const eligible = ["minecraft", "gta-v"];
    expect(pickGamesForToday(eligible, ["minecraft"], false)).toEqual(["minecraft", "gta-v"]);
  });
});

describe("pickVoicesForToday", () => {
  it("uses the default curated pool when voicePool is null, excluding today's used voices", () => {
    const result = pickVoicesForToday({ voicePool: null, preferredSourceIds: [], diversityMode: true }, ["en-US-GuyNeural"]);
    expect(result).not.toContain("en-US-GuyNeural");
    expect(result.length).toBeGreaterThan(0);
  });

  it("respects a directive-supplied voice pool over the default", () => {
    const result = pickVoicesForToday(
      { voicePool: ["voiceA", "voiceB"], preferredSourceIds: [], diversityMode: true },
      ["voiceA"],
    );
    expect(result).toEqual(["voiceB"]);
  });
});

describe("weightSourcesForToday", () => {
  it("ranks preferred sources first, then excludes today's already-used sources", () => {
    const eligible = ["src-a", "src-b", "src-c"];
    const settings = { voicePool: null, preferredSourceIds: ["src-b", "src-c"], diversityMode: true };
    const result = weightSourcesForToday(eligible, settings, ["src-b"]);
    // src-b and src-c are preferred (rank first); src-b was already used
    // today, so it's excluded rather than merely deprioritized — src-c
    // (still preferred, still unused) comes first, src-a follows.
    expect(result).toEqual(["src-c", "src-a"]);
  });

  it("with no preferred sources, ranks by diversity alone", () => {
    const result = weightSourcesForToday(["src-a", "src-b"], { voicePool: null, preferredSourceIds: [], diversityMode: true }, ["src-a"]);
    expect(result).toEqual(["src-b"]);
  });
});
