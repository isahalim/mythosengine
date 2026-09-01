/**
 * The layout table, which is why it lives in a .ts module rather than
 * inside ForgePane.tsx: this repo's tsconfig sets `jsx: preserve` for
 * Astro, so vitest cannot transform a .tsx file — no component under
 * src/app is reachable from a test at all.
 *
 * Worth reaching, because this guards the one thing here that fails in the
 * operator's browser rather than in CI: ForgePane throws on a piece id that
 * is not in the cut, so a typo in FORGE_LAYOUTS takes the whole surface
 * down at render time and nothing upstream would have caught it.
 */
import { describe, expect, it } from "vitest";
import { FORGE_LAYOUTS, forgeLayout } from "./forge-layouts.ts";
import { MOBILE } from "./geometry.ts";

const known = new Set(MOBILE.map((p) => p.id));

describe("FORGE_LAYOUTS", () => {
  it("names only fragments that exist in the portrait cut", () => {
    const unknown = FORGE_LAYOUTS.flatMap((layout) => layout.filter((id) => !known.has(id)));
    expect(unknown).toEqual([]);
  });

  it("gives every layout the same eight fragments' worth of card", () => {
    // Uneven counts would make one card visibly sparser than its
    // neighbours, which is the opposite of what varying the cut is for.
    for (const layout of FORGE_LAYOUTS) expect(layout).toHaveLength(8);
  });

  it("never repeats a fragment inside one layout", () => {
    // A duplicate would stack two identical shards in one place, wasting a
    // slot and double-painting the mask.
    for (const layout of FORGE_LAYOUTS) expect(new Set(layout).size).toBe(layout.length);
  });

  it("makes every layout a different cut", () => {
    const signatures = FORGE_LAYOUTS.map((l) => [...l].sort().join(","));
    expect(new Set(signatures).size).toBe(FORGE_LAYOUTS.length);
  });

  it("gives consecutive cards different cuts", () => {
    // The whole point of the prop: a row of cards must not repeat until it
    // has used every layout.
    const row = [0, 1, 2, 3, 4, 5].map((i) => forgeLayout(i).join(","));
    expect(new Set(row).size).toBe(FORGE_LAYOUTS.length);
  });

  it("wraps rather than falling off the end, for any card index", () => {
    // This is the property that makes "just pass the card's index" safe to
    // promise — including the indices a caller is not supposed to pass.
    for (const variant of [0, 5, 6, 41, -3, 2.7, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(forgeLayout(variant)).toHaveLength(8);
    }
  });

  it("gives the same card the same cut every time", () => {
    // A card that re-cuts itself on a re-render shatters again while the
    // operator is reading it, and takes their uncovered fragments with it.
    expect(forgeLayout(3)).toEqual(forgeLayout(3));
  });
});
