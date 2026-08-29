import { describe, expect, it } from "vitest";
import { pickTtsRate } from "./tts-rate.ts";

describe("pickTtsRate", () => {
  it("returns +0% when no range is set", () => {
    expect(pickTtsRate(null)).toBe("+0%");
  });

  it("picks the minimum when random() returns 0", () => {
    expect(pickTtsRate(["-10%", "+15%"], () => 0)).toBe("-10%");
  });

  it("picks the maximum when random() returns just under 1", () => {
    expect(pickTtsRate(["-10%", "+15%"], () => 0.999999)).toBe("+15%");
  });

  it("formats a positive result with a leading +", () => {
    expect(pickTtsRate(["+5%", "+10%"], () => 0)).toBe("+5%");
  });

  it("formats zero with a leading +", () => {
    expect(pickTtsRate(["0%", "+10%"], () => 0)).toBe("+0%");
  });
});
