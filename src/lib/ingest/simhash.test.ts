import { describe, expect, it } from "vitest";
import { hammingDistance, hexToSimhash, isNearDuplicate, simhash64, simhashToHex } from "./simhash.ts";

describe("simhash64", () => {
  it("is deterministic for the same input", () => {
    const text = "GTA 6 trailer 2 breaks view count records";
    expect(simhash64(text)).toBe(simhash64(text));
  });

  it("produces near-identical fingerprints for a near-duplicate title (single word swap)", () => {
    const a = simhash64("Would you leave everything behind for a fresh start");
    const b = simhash64("Would you leave everything behind for a new start");
    expect(isNearDuplicate(a, b)).toBe(true);
  });

  it("produces a distant fingerprint for an unrelated title", () => {
    const a = simhash64("Apple unveils new iPhone at fall event");
    const b = simhash64("City council approves new bike lane funding downtown");
    expect(isNearDuplicate(a, b)).toBe(false);
  });

  it("hashes empty/whitespace-only text to 0n rather than throwing", () => {
    expect(simhash64("")).toBe(0n);
    expect(simhash64("   ")).toBe(0n);
  });

  it("is case- and punctuation-insensitive", () => {
    const a = simhash64("Would you leave everything behind?");
    const b = simhash64("would you leave everything behind");
    expect(a).toBe(b);
  });
});

describe("hammingDistance", () => {
  it("is 0 for identical fingerprints", () => {
    expect(hammingDistance(0b1010n, 0b1010n)).toBe(0);
  });

  it("counts differing bits", () => {
    expect(hammingDistance(0b0000n, 0b1111n)).toBe(4);
  });
});

describe("hex round-trip", () => {
  it("round-trips a fingerprint through hex", () => {
    const fp = simhash64("some real headline about a trending topic");
    expect(hexToSimhash(simhashToHex(fp))).toBe(fp);
  });

  it("always produces a 16-character hex string", () => {
    expect(simhashToHex(0n)).toHaveLength(16);
    expect(simhashToHex(simhash64("x"))).toHaveLength(16);
  });
});
