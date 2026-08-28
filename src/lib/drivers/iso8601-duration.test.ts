import { describe, expect, it } from "vitest";
import { parseIso8601Duration } from "./iso8601-duration.ts";

describe("parseIso8601Duration", () => {
  it("parses hours, minutes, and seconds", () => {
    expect(parseIso8601Duration("PT1H23M45S")).toBe(1 * 3600 + 23 * 60 + 45);
  });

  it("parses minutes and seconds only", () => {
    expect(parseIso8601Duration("PT45M30S")).toBe(45 * 60 + 30);
  });

  it("parses seconds only (a typical Short)", () => {
    expect(parseIso8601Duration("PT58S")).toBe(58);
  });

  it("parses hours only", () => {
    expect(parseIso8601Duration("PT2H")).toBe(2 * 3600);
  });

  it("returns null for a non-duration string instead of throwing", () => {
    expect(parseIso8601Duration("not a duration")).toBeNull();
    expect(parseIso8601Duration("")).toBeNull();
    expect(parseIso8601Duration("PT")).toBeNull();
  });
});
