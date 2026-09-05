import { describe, expect, it } from "vitest";
import { milestoneFraction } from "./progress.ts";

/**
 * What is left of `orbit.test.ts` after the orbit was removed (operator
 * direction, 2026-09-05). The ring geometry, the tumble, the extrusion, the
 * dust and `dockedFor` are gone with the code they described; the rule that
 * this screen counts facts rather than estimating them is not, and it is the
 * one the operator would notice being broken.
 */
describe("milestoneFraction", () => {
  it("is a count of observed facts, never an estimate", () => {
    expect(milestoneFraction([])).toBe(0);
    expect(milestoneFraction([false, false, false, false, false, false])).toBe(0);
    expect(milestoneFraction([true, true, true, false, false, false])).toBe(0.5);
    expect(milestoneFraction([true, true, true, true, true, true])).toBe(1);
  });

  it("counts facts wherever they are in the list, so an out-of-order stage still counts", () => {
    expect(milestoneFraction([true, false, true, false])).toBe(0.5);
  });
});
