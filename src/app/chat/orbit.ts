/**
 * Where each orbiting fragment is, at a moment in time.
 *
 * Pure arithmetic, deliberately: the rAF loop in `OrbitField.tsx` does
 * nothing but call `orbitPose` / `debrisPose` and write the result to an
 * element, so every decision about how the orbit *looks* is testable without
 * a browser, a canvas or a clock.
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
 *
 * **The ring is a real ring, seen at an angle** (operator direction,
 * 2026-09-05: "make the glass shards go behind the orb and then in front to
 * show the 3Dness during the orbiting"). One number does that and everything
 * that follows from it: `depth = sin(angle)`, +1 at the near edge of the
 * ellipse and -1 at the far edge. It sets the paint order against the orb, the
 * perspective scale, and how much haze a fragment picks up on the far side.
 * A fragment is behind the orb for exactly half of every revolution because
 * that is where the ring actually is, not because a timer said so.
 */

/** Where a shard starts, where it belongs on the ring, and how big it is to begin with. Percentages of the field, matching `Placement`. */
export interface OrbitSeed {
  /** The shard's home on the edge — its `edgeLayout` centre, in % of the field. */
  fromX: number;
  fromY: number;
  /** Its slot on the ring, 0..count-1. */
  index: number;
  count: number;
  /**
   * The fragment's longest side, in % of the field.
   *
   * The edge layout's pieces run from a 6%-wide sliver to a 27%-wide slab,
   * and a single scale factor applied to both leaves one of them a speck and
   * the other a boulder. Normalising against the span is what makes ten
   * wildly different fragments read as one debris field.
   */
  span: number;
}

export interface OrbitCentre {
  /** The orb's centre, in % of the field. */
  x: number;
  y: number;
  /** Ring radii, in % of the field. Elliptical because the ring is tilted away from the viewer, which is the whole source of the depth. */
  rx: number;
  ry: number;
}

export interface OrbitPose {
  /** Offset from the shard's own edge position, in % of the field. Applied as a translate on the wrapper. */
  dx: number;
  dy: number;
  /** Multiplier on the fragment's natural size — small on the ring, large as it docks. */
  scale: number;
  /** Fades a shard out once it has docked — the card's own glass takes over from there. */
  opacity: number;
  /**
   * Where on the ring's near/far axis this fragment is: +1 nearest the
   * viewer, -1 furthest. Negative is *behind the orb*, and the only thing
   * that decides paint order.
   */
  depth: number;
  /** The tumble, in degrees. Three axes, because two of them read as a spin and three read as a solid. */
  rotX: number;
  rotY: number;
  rotZ: number;
}

/** Seconds for one full revolution. Slow: this runs for the length of a render, and anything faster reads as agitation. */
export const ORBIT_PERIOD_S = 26;

/** How long a shard takes to travel from its edge to the ring, in seconds. */
export const GATHER_S = 2.2;

/**
 * The longest side an orbiting fragment settles at, in % of the field
 * (operator direction, 2026-09-05: "way smaller").
 *
 * They arrive at their natural edge size and shrink to this over the gather,
 * which is what makes the gather read as *distance* rather than as ten pieces
 * of furniture sliding across the screen.
 */
export const ORBIT_SPAN = 5.4;

/**
 * The longest side a fully docked fragment reaches, in % of the field.
 *
 * "only get slowly big as a stage finishes and comes to form the video card"
 * — so this is roughly four times `ORBIT_SPAN`, and a shard crosses the gap
 * between them over its own dock, not over the run. Nothing else in this file
 * grows: the ring holds its size for as long as the render takes.
 */
export const DOCK_SPAN = 18;

/**
 * The glass fragments have **thickness** (operator direction, 2026-09-05:
 * "for the orbiting shards that are large, make them have depth as currently
 * when they rotate, you can see them disappear for a bit as they are like
 * paper thinness").
 *
 * A `.shard` is one plane. A plane rotated to 90° is edge-on and therefore
 * *zero pixels wide*, and the tumble here turns at 14-35°/s — so every
 * fragment spent the better part of a second, twice a revolution, being
 * literally nothing. Not a rendering bug: the shard genuinely had no depth.
 *
 * So each fragment is extruded into a slab: `SHARD_DEPTH_LAYERS` copies of
 * its own silhouette, stacked backwards along Z inside the orbit wrapper,
 * which is `transform-style: preserve-3d` so they are separated in space
 * rather than flattened onto the face.
 *
 * *Why a stack of planes reads as a solid.* Rotated θ from face-on, each copy
 * projects to `W·cos θ` wide and consecutive copies are offset by
 * `(depth/layers)·sin θ`. The slab looks continuous while the faces still
 * overlap — `tan θ < W·layers/depth` — which for the ~70px fragment this ring
 * carries is 89.2°, so the copies only stop touching inside the last degree
 * of edge-on, and even there the band is `depth·sin θ` of stacked edges wide.
 * The fragment is never nothing again.
 *
 * *Why 8px and not more.* Thickness and continuity pull against each other:
 * a deeper slab is more obviously solid when it is turned, and breaks up
 * sooner as it turns further. Eight pixels is 11% of the orbiting fragment's
 * own width — the proportion of a real shard of window glass — and holds the
 * angle above.
 *
 * *Why the depth is in pixels and not a fraction of the fragment.* The
 * wrapper's transform ends in `scale()`, which is a 2D scale — it multiplies
 * X and Y and leaves Z alone. So one `translateZ` gives every fragment the
 * same thickness on screen, whether the wrapper it hangs in is a 6% sliver or
 * a 27% slab, and it does not change as a shard grows into the card. Glass
 * from one sheet, cut into different pieces.
 */
export const SHARD_DEPTH_PX = 8;

/**
 * How many copies make the slab. Eight is what puts the break-up above 89°
 * at this depth; more is ten shards × N masked elements for a difference no
 * one can see, on a screen that already runs a rAF loop over ninety of them.
 */
export const SHARD_DEPTH_LAYERS = 8;

/** One copy in the extrusion: how far back it sits, and how much it tints. */
export interface DepthLayer {
  /** Its offset along Z, in px. Negative — the extrusion goes backwards from the lit face. */
  z: number;
  /** Its own alpha. Deliberately small: eight of these stack up behind the face when it is turned toward the viewer, and a fragment that goes opaque face-on has traded one wrong look for another. */
  alpha: number;
}

/**
 * The extrusion, as data — so the arithmetic above is a test rather than a
 * claim in a comment.
 *
 * The alpha ramps *down* with depth. Physically that is the far side of the
 * glass seen through the near side; practically it is what stops the stack
 * reading as a shadow under the fragment when it is face-on.
 */
export function depthLayers(layers = SHARD_DEPTH_LAYERS, depth = SHARD_DEPTH_PX): DepthLayer[] {
  const out: DepthLayer[] = [];
  for (let i = 1; i <= layers; i++) {
    const t = i / layers;
    out.push({ z: -depth * t, alpha: 0.13 * (1 - t * 0.55) });
  }
  return out;
}

/** How much nearer the near edge of the ring looks than the far edge. Perspective, applied as a plain multiplier — the ring is shallow enough not to need a projection. */
const DEPTH_SCALE = 0.42;

/**
 * A deterministic 0..1 from an integer.
 *
 * The golden-ratio conjugate spreads consecutive indices about as far apart
 * as anything can, so ten shards get ten different sizes and tumbles without
 * a random number generator — which matters because these poses have to be
 * the same on every render and in every test run.
 */
export function spread(index: number, offset = 0): number {
  const x = (index + 1) * 0.618033988749895 + offset;
  return x - Math.floor(x);
}

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
  const settle = Math.min(1, Math.max(0, docked));

  // Evenly spaced around the ring, starting at 12 o'clock so the first shard
  // to arrive is the one directly under the orb.
  const angle = (seed.index / Math.max(1, seed.count)) * Math.PI * 2 - Math.PI / 2 + (elapsed / ORBIT_PERIOD_S) * Math.PI * 2;

  // +1 at the near edge of the ellipse, -1 at the far edge. The ring is
  // tilted toward the viewer, so the near half is the *lower* half — which is
  // why this is the same sine that places the fragment vertically.
  const depth = Math.sin(angle);

  const ringX = centre.x + Math.cos(angle) * centre.rx;
  const ringY = centre.y + depth * centre.ry;

  // Docking collapses the ring toward the centre rather than teleporting the
  // shard: the board's "larger chunks of glass shards start forming the video
  // card" is a piece leaving the orbit and joining the pane, not a piece
  // vanishing and a pane appearing.
  const targetX = ringX + (centre.x - ringX) * settle;
  const targetY = ringY + (centre.y - ringY) * settle;

  // Two lerps, in the order the fragment lives them. It starts at its edge
  // size (1), shrinks to the ring over the gather, and only then grows toward
  // the card as its milestone lands. A shard that has not docked never
  // reaches the second one.
  const varied = 0.62 + spread(seed.index) * 0.76;
  const span = Math.max(seed.span, 0.001);
  const ringScale = ((ORBIT_SPAN * varied) / span) * (1 + depth * DEPTH_SCALE);
  const dockScale = (DOCK_SPAN * varied) / span;
  const gathered = 1 + (ringScale - 1) * gather;

  // The tumble is damped by both ends of the journey: nothing spins while it
  // is still pinned to the edge, and nothing spins once it is part of the
  // card. A card assembled out of rotating fragments would be a card that
  // never finishes.
  const tumble = gather * (1 - settle);
  const t = elapsed;

  return {
    dx: (targetX - seed.fromX) * gather,
    dy: (targetY - seed.fromY) * gather,
    scale: gathered + (dockScale - gathered) * settle,
    // Held at full opacity until the shard is most of the way home, then
    // taken out over the last stretch — a fragment that faded from the moment
    // it started docking would spend the whole journey looking broken. The
    // far side of the ring is dimmer for the same reason it is smaller.
    opacity: (settle < 0.7 ? 1 : 1 - (settle - 0.7) / 0.3) * (depth < 0 ? 1 + depth * 0.34 : 1),
    depth,
    rotX: tumble * (t * (11 + spread(seed.index, 0.31) * 17) + spread(seed.index, 0.11) * 360),
    rotY: tumble * (t * (14 + spread(seed.index, 0.57) * 21) + spread(seed.index, 0.43) * 360),
    rotZ: tumble * (t * (7 + spread(seed.index, 0.79) * 12) + spread(seed.index, 0.67) * 360),
  };
}

/**
 * One speck of the dust the ring trails (operator direction, 2026-09-05:
 * "a bunch of trailing very minute glass debris that are non interactable").
 *
 * Seeds rather than live state: a speck is fully described by where on the
 * ring it started and how fast it goes round, so the loop can place any
 * number of them from arithmetic alone and none of them needs remembering.
 */
export interface DebrisSeed {
  /** Its angle on the ring at t=0, radians. */
  phase: number;
  /** Multiplier on the ring radii — spread wide, which is what turns a line into a band. */
  radius: number;
  /** Multiplier on the angular speed. Inner specks run faster, so the band shears into trails instead of holding formation. */
  speed: number;
  /** How far off the ring plane it sits, in % of the field. */
  drift: number;
  /** Its size in pixels at depth 0. "Very minute" — one to four pixels. */
  size: number;
  /** Base opacity, before depth. */
  alpha: number;
}

export interface DebrisPose {
  /** Position in % of the field — absolute, not an offset: a speck has no home to leave. */
  x: number;
  y: number;
  depth: number;
  scale: number;
  opacity: number;
}

/**
 * `count` specks spread over the ring, deterministically.
 *
 * The radius spread is deliberately wide (0.58..1.46) and the speed is tied
 * to it inversely: the inner specks lap the outer ones, so a band that starts
 * evenly spaced smears itself into trailing arcs within a few seconds and
 * stays that way. That is the whole trick — nothing here animates a trail,
 * the trail is what differential rotation does to a ring on its own.
 */
export function debrisSeeds(count: number): DebrisSeed[] {
  const seeds: DebrisSeed[] = [];
  for (let i = 0; i < count; i++) {
    const radius = 0.58 + spread(i, 0.13) * 0.88;
    seeds.push({
      phase: spread(i) * Math.PI * 2,
      radius,
      // Kepler's third law in spirit rather than in earnest: closer is
      // faster. The exponent is picked so the innermost speck laps the
      // outermost roughly twice per revolution, which is enough shear to see
      // and not so much that the band blurs into a smear.
      speed: Math.pow(radius, -0.9),
      drift: (spread(i, 0.37) - 0.5) * 3.4,
      size: 1 + spread(i, 0.71) * 3,
      alpha: 0.22 + spread(i, 0.29) * 0.5,
    });
  }
  return seeds;
}

/** Where a speck is at `elapsed` seconds. Same ring, same depth rule, same tilt as the shards — they have to share a plane or neither reads as one. */
export function debrisPose(seed: DebrisSeed, centre: OrbitCentre, elapsed: number): DebrisPose {
  const angle = seed.phase + (elapsed / ORBIT_PERIOD_S) * Math.PI * 2 * seed.speed;
  const depth = Math.sin(angle);
  return {
    x: centre.x + Math.cos(angle) * centre.rx * seed.radius,
    y: centre.y + depth * centre.ry * seed.radius + seed.drift,
    depth,
    scale: 1 + depth * DEPTH_SCALE,
    opacity: seed.alpha * (depth < 0 ? 1 + depth * 0.45 : 1),
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
