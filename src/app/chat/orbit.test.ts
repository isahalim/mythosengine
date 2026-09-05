import { describe, expect, it } from "vitest";
import {
  debrisPose,
  debrisSeeds,
  depthLayers,
  dockedFor,
  dockedFraction,
  DOCK_SPAN,
  easeOut,
  GATHER_S,
  ORBIT_PERIOD_S,
  ORBIT_SPAN,
  orbitPose,
  SHARD_DEPTH_LAYERS,
  SHARD_DEPTH_PX,
  spread,
  type OrbitCentre,
  type OrbitSeed,
} from "./orbit.ts";

/**
 * The orbit's arithmetic, tested away from rAF and the DOM.
 *
 * That separation is why `orbit.ts` exists as its own file: `OrbitField.tsx`
 * is a loop that writes what these functions return, so everything about how
 * the orbit behaves can be checked without a browser.
 */

const CENTRE: OrbitCentre = { x: 50, y: 50, rx: 27, ry: 13 };
const seed = (index: number, count = 4, fromX = 0, fromY = 0, span = 20): OrbitSeed => ({ fromX, fromY, index, count, span });

/** The elapsed time at which a given index sits on the near half of the ring, so a test can pick a moment rather than hope for one. */
function nearHalf(index: number, count: number): number {
  // angle = index/count*2π - π/2 + (t/period)*2π, and depth is sin(angle), so
  // the near point is angle = π/2 — half a period on from where index 0
  // starts, less however far round the ring this index already is.
  const t = ORBIT_PERIOD_S * (0.5 - index / count);
  return t < GATHER_S ? t + ORBIT_PERIOD_S : t;
}

describe("easeOut", () => {
  it("clamps outside 0..1 rather than overshooting", () => {
    expect(easeOut(-3)).toBe(0);
    expect(easeOut(4)).toBe(1);
  });

  it("front-loads the motion, which is what makes a shard leave its edge and settle", () => {
    expect(easeOut(0.5)).toBeGreaterThan(0.5);
  });
});

describe("spread", () => {
  it("is deterministic, because these poses have to survive a reload and a test run unchanged", () => {
    expect(spread(3)).toBe(spread(3));
    expect(spread(3, 0.2)).toBe(spread(3, 0.2));
  });

  it("stays inside 0..1 and does not repeat across a ring's worth of indices", () => {
    const values = Array.from({ length: 12 }, (_, i) => spread(i));
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    expect(new Set(values.map((v) => v.toFixed(6))).size).toBe(12);
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
    expect(pose.scale).toBe(1);
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

  /*
   * Operator direction, 2026-09-05: "way smaller ... and only get slowly big
   * as a stage finishes and comes to form the video card". Two assertions,
   * because the instruction has two halves and either one alone would let the
   * other regress silently.
   */
  it("shrinks a fragment to a fraction of its edge size once it is on the ring", () => {
    const s = seed(0, 4, 0, 0, 20);
    const pose = orbitPose(s, CENTRE, GATHER_S, 0);
    expect(pose.scale).toBeLessThan(0.6);
    // Normalised against the fragment's own span, so a 6% sliver and a 27%
    // slab end up the same size on the ring rather than one of each.
    const slab = orbitPose(seed(0, 4, 0, 0, 44), CENTRE, GATHER_S, 0);
    expect(slab.scale * 44).toBeCloseTo(pose.scale * 20, 6);
  });

  it("grows a docking fragment well past its ring size, and lands it near the centre", () => {
    const s = seed(0, 4, 0, 0);
    const orbiting = orbitPose(s, CENTRE, GATHER_S, 0);
    const halfway = orbitPose(s, CENTRE, GATHER_S, 0.5);
    const docked = orbitPose(s, CENTRE, GATHER_S, 1);

    expect(halfway.scale).toBeGreaterThan(orbiting.scale);
    expect(docked.scale).toBeGreaterThan(halfway.scale);
    expect(DOCK_SPAN).toBeGreaterThan(ORBIT_SPAN);

    // The dock is a journey to the centre, not a jump: the pose lands the
    // fragment on the orb rather than leaving it on the ring.
    expect(Math.hypot(s.fromX + docked.dx - CENTRE.x, s.fromY + docked.dy - CENTRE.y)).toBeCloseTo(0, 6);
  });

  it("puts half the ring behind the orb and half in front, because that is where a tilted ring is", () => {
    const count = 8;
    const depths = Array.from({ length: count }, (_, i) => orbitPose(seed(i, count), CENTRE, GATHER_S, 0).depth);
    expect(depths.filter((d) => d < 0).length).toBe(4);
    expect(depths.filter((d) => d >= 0).length).toBe(4);
  });

  it("ties depth to the vertical position, so a near fragment is the low one and reads as nearer", () => {
    const s = seed(0, 4, 0, 0);
    const near = orbitPose(s, CENTRE, nearHalf(0, 4), 0);
    const far = orbitPose(s, CENTRE, nearHalf(0, 4) + ORBIT_PERIOD_S / 2, 0);

    expect(near.depth).toBeGreaterThan(0.99);
    expect(far.depth).toBeLessThan(-0.99);
    // Lower on the screen, larger, and not hazed.
    expect(near.dy).toBeGreaterThan(far.dy);
    expect(near.scale).toBeGreaterThan(far.scale);
    expect(near.opacity).toBeGreaterThan(far.opacity);
  });

  it("tumbles on three axes at once — two would read as a spin, three read as a solid", () => {
    const s = seed(1);
    const a = orbitPose(s, CENTRE, GATHER_S + 1, 0);
    const b = orbitPose(s, CENTRE, GATHER_S + 4, 0);
    expect(b.rotX).not.toBeCloseTo(a.rotX, 3);
    expect(b.rotY).not.toBeCloseTo(a.rotY, 3);
    expect(b.rotZ).not.toBeCloseTo(a.rotZ, 3);
    // Different rates, or the three axes would be one rotation in disguise.
    expect(b.rotX - a.rotX).not.toBeCloseTo(b.rotY - a.rotY, 3);
  });

  it("gives different fragments different tumbles, so ten pieces are not one piece ten times", () => {
    const angles = [0, 1, 2, 3].map((i) => orbitPose(seed(i), CENTRE, GATHER_S + 5, 0).rotY.toFixed(3));
    expect(new Set(angles).size).toBe(4);
  });

  it("stops the tumble at both ends — nothing spins on the edge, nothing spins inside the card", () => {
    const s = seed(1);
    const pinned = orbitPose(s, CENTRE, 0, 0);
    expect(pinned.rotX).toBe(0);
    expect(pinned.rotY).toBe(0);
    expect(pinned.rotZ).toBe(0);

    const landed = orbitPose(s, CENTRE, GATHER_S + 5, 1);
    expect(landed.rotX).toBe(0);
    expect(landed.rotY).toBe(0);
    expect(landed.rotZ).toBe(0);
  });

  it("holds a docking shard at full opacity for most of the journey, then takes it out", () => {
    const s = seed(0);
    // Read as a ratio against the same moment undocked, so the far side's
    // haze — which is about depth, not docking — cannot flip this test.
    const base = orbitPose(s, CENTRE, GATHER_S, 0).opacity;
    expect(orbitPose(s, CENTRE, GATHER_S, 0.5).opacity / base).toBeCloseTo(1, 5);
    expect(orbitPose(s, CENTRE, GATHER_S, 0.7).opacity / base).toBeCloseTo(1, 5);
    expect(orbitPose(s, CENTRE, GATHER_S, 0.85).opacity / base).toBeCloseTo(0.5, 2);
    expect(orbitPose(s, CENTRE, GATHER_S, 1).opacity).toBeCloseTo(0, 5);
  });

  it("clamps a docked fraction outside 0..1 rather than flinging the shard past the centre", () => {
    const s = seed(0);
    expect(orbitPose(s, CENTRE, GATHER_S, 3).scale).toBeCloseTo(orbitPose(s, CENTRE, GATHER_S, 1).scale, 5);
    expect(orbitPose(s, CENTRE, GATHER_S, -2).scale).toBeCloseTo(orbitPose(s, CENTRE, GATHER_S, 0).scale, 5);
  });

  it("never divides by zero when it is handed an empty ring or a zero-span fragment", () => {
    const empty = orbitPose({ fromX: 0, fromY: 0, index: 0, count: 0, span: 20 }, CENTRE, GATHER_S, 0);
    expect(Number.isFinite(empty.dx)).toBe(true);
    expect(Number.isFinite(empty.dy)).toBe(true);

    const flat = orbitPose(seed(0, 4, 0, 0, 0), CENTRE, GATHER_S, 0);
    expect(Number.isFinite(flat.scale)).toBe(true);
  });
});

describe("debris", () => {
  it("is deterministic and as many specks as it was asked for", () => {
    expect(debrisSeeds(40)).toHaveLength(40);
    expect(debrisSeeds(12)).toEqual(debrisSeeds(12));
    expect(debrisSeeds(0)).toEqual([]);
  });

  it("is very minute, and spread over a band rather than a line", () => {
    const seeds = debrisSeeds(60);
    for (const s of seeds) {
      expect(s.size).toBeGreaterThanOrEqual(1);
      expect(s.size).toBeLessThanOrEqual(4);
    }
    const radii = seeds.map((s) => s.radius);
    expect(Math.max(...radii) - Math.min(...radii)).toBeGreaterThan(0.5);
  });

  it("runs the inner specks faster than the outer ones, which is what shears the band into trails", () => {
    const seeds = debrisSeeds(60);
    const inner = seeds.reduce((a, b) => (a.radius < b.radius ? a : b));
    const outer = seeds.reduce((a, b) => (a.radius > b.radius ? a : b));
    expect(inner.speed).toBeGreaterThan(outer.speed);
  });

  it("shares the shards' ring, tilt and depth rule, or neither would read as one plane", () => {
    const s = debrisSeeds(8)[0];
    const over = Array.from({ length: 24 }, (_, i) => debrisPose(s, CENTRE, i));
    expect(over.some((p) => p.depth < 0)).toBe(true);
    expect(over.some((p) => p.depth > 0)).toBe(true);

    const near = over.reduce((a, b) => (a.depth > b.depth ? a : b));
    const far = over.reduce((a, b) => (a.depth < b.depth ? a : b));
    expect(near.y).toBeGreaterThan(far.y);
    expect(near.scale).toBeGreaterThan(far.scale);
    expect(near.opacity).toBeGreaterThan(far.opacity);
  });

  it("stays inside the field it is given rather than flying off the screen", () => {
    for (const s of debrisSeeds(40)) {
      for (let t = 0; t < ORBIT_PERIOD_S; t += 1.5) {
        const p = debrisPose(s, CENTRE, t);
        expect(Math.abs(p.x - CENTRE.x)).toBeLessThan(CENTRE.rx * 1.5);
        expect(Math.abs(p.y - CENTRE.y)).toBeLessThan(CENTRE.ry * 1.5 + 2);
      }
    }
  });
});

/**
 * The fragments have a body (operator direction, 2026-09-05: "make them have
 * depth as currently when they rotate, you can see them disappear for a bit
 * as they are like paper thinness").
 */
describe("depthLayers", () => {
  it("extrudes backwards from the lit face, never in front of it", () => {
    const layers = depthLayers();
    expect(layers).toHaveLength(SHARD_DEPTH_LAYERS);
    for (const layer of layers) expect(layer.z).toBeLessThan(0);
    expect(Math.min(...layers.map((l) => l.z))).toBeCloseTo(-SHARD_DEPTH_PX, 6);
  });

  it("steps evenly, which is what makes the edge read as one slab", () => {
    const zs = depthLayers().map((l) => l.z);
    const steps = zs.slice(1).map((z, i) => z - zs[i]);
    for (const step of steps) expect(step).toBeCloseTo(steps[0], 6);
  });

  /**
   * The reason the count and the depth are a pair. A stack of planes stops
   * looking solid once consecutive faces no longer overlap, which happens at
   * `tan θ = W·layers/depth`. For the ~70px fragment this ring carries that
   * has to be inside the last degree of edge-on, or the fragment is briefly
   * paper again — the bug this exists to fix.
   */
  it("keeps the slab continuous to within a degree of edge-on, at the ring's own fragment size", () => {
    const fragmentPx = 70;
    const breakUp = (Math.atan((fragmentPx * SHARD_DEPTH_LAYERS) / SHARD_DEPTH_PX) * 180) / Math.PI;
    expect(breakUp).toBeGreaterThan(89);
  });

  it("keeps every copy faint — eight of them stack up behind a face-on fragment", () => {
    const total = depthLayers().reduce((sum, l) => sum + l.alpha, 0);
    for (const layer of depthLayers()) expect(layer.alpha).toBeLessThan(0.15);
    expect(total).toBeLessThan(1);
  });

  it("fades with depth, so the far side of the glass is the dimmest part of it", () => {
    const layers = depthLayers();
    for (const [i, layer] of layers.entries()) if (i > 0) expect(layer.alpha).toBeLessThan(layers[i - 1].alpha);
  });
});
