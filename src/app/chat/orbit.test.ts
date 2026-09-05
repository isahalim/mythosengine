import { describe, expect, it } from "vitest";
import { dockedFor, dockedFraction, easeOut, GATHER_S, ORBIT_PERIOD_S, orbitPose, type OrbitCentre, type OrbitSeed } from "./orbit.ts";

/**
 * The orbit's arithmetic, tested away from rAF and the DOM.
 *
 * That separation is why `orbit.ts` exists as its own file: `OrbitField.tsx`
 * is a loop that writes what these functions return, so everything about how
 * the orbit behaves can be checked without a browser.
 */

const CENTRE: OrbitCentre = { x: 50, y: 34, rx: 26, ry: 15 };
const seed = (index: number, count = 4, fromX = 0, fromY = 0): OrbitSeed => ({ fromX, fromY, index, count });

describe("easeOut", () => {
  it("clamps outside 0..1 rather than overshooting", () => {
    expect(easeOut(-3)).toBe(0);
    expect(easeOut(4)).toBe(1);
  });

  it("front-loads the motion, which is what makes a shard leave its edge and settle", () => {
    expect(easeOut(0.5)).toBeGreaterThan(0.5);
  });
});

describe("dockedFraction", () => {
  it("is a count of observed facts, never an estimate", () => {
    expect(dockedFraction([])).toBe(0);
    expect(dockedFraction([false, false, false, false, false, false])).toBe(0);
    expect(dockedFraction([true, true, true, false, false, false])).toBe(0.5);
    expect(dockedFraction([true, true, true, true, true, true])).toBe(1);
  });

  it("counts facts wherever they are in the list, so an out-of-order stage still counts", () => {
    expect(dockedFraction([true, false, true, false])).toBe(0.5);
  });
});

describe("dockedFor", () => {
  it("docks shards one at a time, in ring order", () => {
    // Half the run done, ten shards: the first five are home, the rest have
    // not started.
    expect(dockedFor(0, 10, 0.5)).toBe(1);
    expect(dockedFor(4, 10, 0.5)).toBe(1);
    expect(dockedFor(5, 10, 0.5)).toBe(0);
    expect(dockedFor(9, 10, 0.5)).toBe(0);
  });

  it("gives the one shard in flight a partial value, so the card assembles piece by piece", () => {
    expect(dockedFor(2, 10, 0.25)).toBeCloseTo(0.5);
  });

  it("has nothing docked at zero and everything docked at one", () => {
    for (let i = 0; i < 10; i++) {
      expect(dockedFor(i, 10, 0)).toBe(0);
      expect(dockedFor(i, 10, 1)).toBe(1);
    }
  });
});

describe("orbitPose", () => {
  it("leaves a shard where it is before the gather has begun", () => {
    const pose = orbitPose(seed(0, 4, 12, 8), CENTRE, 0, 0);
    expect(pose.dx).toBe(0);
    expect(pose.dy).toBe(0);
    expect(pose.opacity).toBe(1);
  });

  it("has moved it onto the ring by the end of the gather", () => {
    // Index 0 at t=GATHER_S: the ring has turned, so assert the shard is
    // roughly a ring-radius from the centre rather than at one exact point.
    const s = seed(0, 4, 0, 0);
    const pose = orbitPose(s, CENTRE, GATHER_S, 0);
    const x = s.fromX + pose.dx;
    const y = s.fromY + pose.dy;
    const normalized = ((x - CENTRE.x) / CENTRE.rx) ** 2 + ((y - CENTRE.y) / CENTRE.ry) ** 2;
    expect(normalized).toBeCloseTo(1, 1);
  });

  it("returns to the same place one period later", () => {
    const s = seed(1);
    const a = orbitPose(s, CENTRE, GATHER_S + 3, 0);
    const b = orbitPose(s, CENTRE, GATHER_S + 3 + ORBIT_PERIOD_S, 0);
    expect(b.dx).toBeCloseTo(a.dx, 3);
    expect(b.dy).toBeCloseTo(a.dy, 3);
  });

  it("spaces the shards evenly around the ring rather than stacking them", () => {
    const positions = [0, 1, 2, 3].map((i) => {
      const s = seed(i);
      const pose = orbitPose(s, CENTRE, GATHER_S, 0);
      return `${(s.fromX + pose.dx).toFixed(2)},${(s.fromY + pose.dy).toFixed(2)}`;
    });
    expect(new Set(positions).size).toBe(4);
  });

  it("collapses a docked shard toward the centre and shrinks it, rather than teleporting it", () => {
    const s = seed(0, 4, 0, 0);
    const orbiting = orbitPose(s, CENTRE, GATHER_S, 0);
    const docked = orbitPose(s, CENTRE, GATHER_S, 1);

    expect(Math.hypot(docked.dx - CENTRE.x, docked.dy - CENTRE.y)).toBeLessThan(Math.hypot(orbiting.dx - CENTRE.x, orbiting.dy - CENTRE.y));
    expect(docked.scale).toBeLessThan(orbiting.scale);
  });

  it("holds a docking shard at full opacity for most of the journey, then takes it out", () => {
    const s = seed(0);
    expect(orbitPose(s, CENTRE, GATHER_S, 0.5).opacity).toBe(1);
    expect(orbitPose(s, CENTRE, GATHER_S, 0.7).opacity).toBe(1);
    expect(orbitPose(s, CENTRE, GATHER_S, 0.85).opacity).toBeCloseTo(0.5, 2);
    expect(orbitPose(s, CENTRE, GATHER_S, 1).opacity).toBeCloseTo(0, 5);
  });

  it("clamps a docked fraction outside 0..1 rather than flinging the shard past the centre", () => {
    const s = seed(0);
    expect(orbitPose(s, CENTRE, GATHER_S, 3).scale).toBeCloseTo(orbitPose(s, CENTRE, GATHER_S, 1).scale, 5);
    expect(orbitPose(s, CENTRE, GATHER_S, -2).scale).toBeCloseTo(orbitPose(s, CENTRE, GATHER_S, 0).scale, 5);
  });

  it("never divides by zero when it is handed an empty ring", () => {
    const pose = orbitPose({ fromX: 0, fromY: 0, index: 0, count: 0 }, CENTRE, GATHER_S, 0);
    expect(Number.isFinite(pose.dx)).toBe(true);
    expect(Number.isFinite(pose.dy)).toBe(true);
  });
});
