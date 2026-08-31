import { describe, expect, it } from "vitest";

import { parseHex } from "./palette.ts";

/*
  readGlassPalette itself needs getComputedStyle, and this repo's vitest runs
  in node with no jsdom (adding one would be a new dependency — CLAUDE.md).
  parseHex is the part that decides between "mount the shader" and "keep the
  CSS fallback", so it is the part worth pinning down.
*/
describe("parseHex", () => {
  it("parses the six-digit form the console tokens use", () => {
    expect(parseHex("#ffffff")).toEqual([1, 1, 1]);
    expect(parseHex("#000000")).toEqual([0, 0, 0]);
  });

  it("expands the three-digit shorthand", () => {
    expect(parseHex("#fff")).toEqual([1, 1, 1]);
    // #b39dff is --orb-4; its shorthand neighbour must expand pairwise,
    // not by padding with zeroes.
    expect(parseHex("#b9f")).toEqual(parseHex("#bb99ff"));
  });

  it("tolerates the leading space getPropertyValue returns for a custom property", () => {
    // `getComputedStyle(el).getPropertyValue("--orb-1")` yields " #ff9ec4"
    // in every engine — an untrimmed parse here would blank the palette and
    // silently drop every console page to the CSS fallback.
    expect(parseHex(" #ff9ec4 ")).toEqual(parseHex("#ff9ec4"));
  });

  it("returns null rather than a partial colour for a value it cannot read", () => {
    // color-mix()/var() indirection, an empty token, a named colour: all
    // must fail loudly to null so the caller keeps its fallback, never
    // resolve to a half-parsed black.
    for (const bad of ["", "  ", "rebeccapurple", "#ff9e", "#gggggg", "color-mix(in srgb, red, blue)"]) {
      expect(parseHex(bad)).toBeNull();
    }
  });

  it("maps byte values onto 0..1 rather than 0..255", () => {
    // The shader multiplies these into a colour directly; a 0..255 triple
    // would blow every sphere out to white.
    expect(parseHex("#80ff00")).toEqual([128 / 255, 1, 0]);
  });
});
