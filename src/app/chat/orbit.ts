/**
 * Where each orbiting shard is, at a moment in time.
 *
 * Pure arithmetic, deliberately: the rAF loop in `OrbitField.tsx` does
 * nothing but call `orbitPose` and write the result to a wrapper's
 * `transform`, so every decision about how the orbit *looks* is testable
 * without a browser, a canvas or a clock.
 *
 * **Why a wrapper transform and not the shard's own.** `useShardField` owns
 * `.shard`'s transform — it writes a spring-damped tilt there every frame and
 * resets it from its pointer handlers — and its targets are private to that
 * effect. Pushing orbit positions through it is not possible, and racing it
 * for the same element would make both stutter. So the orbit is a layer above
 * it, exactly as `ShardPlayer` puts its spread on a wrapper and leaves the
 * spring alone. Three transforms, three owners, no two on one element.
 *
 * The board asks for the shards to be "gathered from the edges of the
 * website", so the orbit starts at each fragment's real edge position and
 * eases inward — the pieces the operator has been looking at all session are
 * the pieces that come.
 */

/** Where a shard starts and where it belongs on the ring. Percentages of the field, matching `Placement`. */
export interface OrbitSeed {
  /** The shard's home on the edge — its `edgeLayout` centre, in % of the field. */
  fromX: number;
  fromY: number;
  /** Its slot on the ring, 0..count-1. */
  index: number;
  count: number;
}

export interface OrbitCentre {
  /** The orb's centre, in % of the field. */
  x: number;
  y: number;
  /** Ring radii, in % of the field. Elliptical because the field is wider than it is tall, exactly as `ringPositions` is. */
  rx: number;
  ry: number;
}

export interface OrbitPose {
  /** Offset from the shard's own edge position, in % of the field. Applied as a translate on the wrapper. */
  dx: number;
  dy: number;
  /** 1 while orbiting; shrinks as a shard docks into the healing card. */
  scale: number;
  /** Fades a shard out once it has docked — the card's own glass takes over from there. */
  opacity: number;
}

/** Seconds for one full revolution. Slow: this runs for the length of a render, and anything faster reads as agitation. */
export const ORBIT_PERIOD_S = 26;

/** How long a shard takes to travel from its edge to the ring, in seconds. */
export const GATHER_S = 2.2;

/**
 * Ease-out cubic — the same curve `--ease-out` describes in CSS, in
 * arithmetic. Used for the gather so a shard leaves its edge quickly and
 * settles into the ring rather than arriving at constant speed.
 */
export function easeOut(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - clamped, 3);
}

/**
 * The shard's pose at `elapsed` seconds, given how much of the run is done.
 *
 * `docked` is the fraction of this shard's journey into the card — 0 while it
 * is still orbiting, 1 once the milestone that claims it has landed. It is
 * driven by counted pipeline facts, never by a timer, which is the same rule
 * stage 5's `fractureOf` follows and the reason neither screen can ever show
 * progress that did not happen.
 */
export function orbitPose(seed: OrbitSeed, centre: OrbitCentre, elapsed: number, docked: number): OrbitPose {
  const gather = easeOut(elapsed / GATHER_S);

  // Evenly spaced around the ring, starting at 12 o'clock so the first shard
  // to arrive is the one directly under the orb.
  const angle = (seed.index / Math.max(1, seed.count)) * Math.PI * 2 - Math.PI / 2 + (elapsed / ORBIT_PERIOD_S) * Math.PI * 2;

  const ringX = centre.x + Math.cos(angle) * centre.rx;
  const ringY = centre.y + Math.sin(angle) * centre.ry;

  // Docking collapses the ring toward the centre rather than teleporting the
  // shard: the board's "larger chunks of glass shards start forming the video
  // card" is a piece leaving the orbit and joining the pane, not a piece
  // vanishing and a pane appearing.
  const settle = Math.min(1, Math.max(0, docked));
  const targetX = ringX + (centre.x - ringX) * settle;
  const targetY = ringY + (centre.y - ringY) * settle;

  return {
    dx: (targetX - seed.fromX) * gather,
    dy: (targetY - seed.fromY) * gather,
    scale: 1 - settle * 0.45,
    // Held at full opacity until the shard is most of the way home, then
    // taken out over the last stretch — a fragment that faded from the moment
    // it started docking would spend the whole journey looking broken.
    opacity: settle < 0.7 ? 1 : 1 - (settle - 0.7) / 0.3,
  };
}

/**
 * How far into the orbit-to-card journey the run is, from **counted facts**.
 *
 * The rule this obeys is stated in three other places in this codebase and
 * holds here too: progress is a count of things that have observably happened,
 * never an estimate and never a timer. `Stage5Forge`'s `milestones` counts
 * four; the chat route counts six, because two stages run before SCRIPT on
 * this route and the operator is watching all of them.
 */
export function dockedFraction(milestones: readonly boolean[]): number {
  if (milestones.length === 0) return 0;
  return milestones.filter(Boolean).length / milestones.length;
}

/**
 * Which shards have docked, given how far along the run is.
 *
 * Shards dock one at a time, in ring order, so the card visibly assembles
 * piece by piece rather than every fragment sliding in together. A shard is
 * either travelling or arrived — the partial value is only ever for the one
 * currently in flight.
 */
export function dockedFor(index: number, count: number, progress: number): number {
  const claimed = progress * count;
  if (index + 1 <= claimed) return 1;
  if (index >= claimed) return 0;
  return claimed - index;
}
