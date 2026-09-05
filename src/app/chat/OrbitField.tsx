import { useEffect, useMemo, useRef, useState } from "react";
import { preloadAtlas, type SetKey } from "../glass/geometry.ts";
import { edgeLayout } from "../glass/layouts.ts";
import { Shard } from "../glass/Shard.tsx";
import { useShardField } from "../glass/useShardField.ts";
import { OrbLazy } from "../orb/OrbLazy.tsx";
import { useAtlasReady } from "../useAtlasReady.ts";
import { debrisPose, debrisSeeds, dockedFor, GATHER_S, orbitPose, type OrbitCentre, type OrbitSeed } from "./orbit.ts";

/**
 * The orb, the shards it gathers, the ring they orbit on, and the dust that
 * ring trails.
 *
 * The design board: "blackhole gathers glass shards ... radially and makes
 * them orbit it", "lots of small ~ medium glass shards orbiting by gathering
 * pieces from edges of website", and then "slowly as each stage of the
 * pipeline finishes, larger chunks of glass shards start forming the video
 * card until it's fully healed". The black hole is the gradient orb since
 * 2026-09-04 (operator direction); everything else is as drawn.
 *
 * **Where the pieces come from is literal.** `edgeLayout` is the same
 * function `EdgeFrame` uses to pin glass to the borders of every other
 * screen, so these are the fragments the operator has been looking at all
 * session, leaving their edges and coming inward. That is why this component
 * replaces `EdgeFrame` on the building screen rather than drawing over it —
 * two sets of border glass, one of them departing, would read as a copy.
 *
 * **Why the orb is inside this component** (operator direction, 2026-09-05:
 * "make the glass shards go behind the orb and then in front to show the
 * 3Dness during the orbiting"). A fragment can only be painted behind one
 * element and in front of another if all three are siblings in one stacking
 * context. While the orb lived in `StageBuilding`'s content column and the
 * shards lived in a fixed layer behind it, no z-index on any shard could ever
 * put it in front — the whole layer was behind. So the scene owns all three
 * layers, in paint order:
 *
 *   z-index 1  fragments and dust on the far half of the ring
 *   z-index 2  the orb
 *   z-index 3  fragments and dust on the near half
 *
 * and the loop moves an element between 1 and 3 by writing `zIndex`, which is
 * one string assignment twice per revolution rather than a DOM move.
 *
 * **Three transform layers, three owners, and none of them share an
 * element.** This is the load-bearing detail:
 *
 *   1. `.orbit-shard` (the wrapper) — written here, every frame, from
 *      `orbitPose`. The orbit, the gather, the tumble, and the dock.
 *   2. `.shard` — owned entirely by `useShardField`'s spring loop: the tilt,
 *      the parallax and the hover lift. Never touched from this file.
 *   3. Nothing else. In particular the wrapper does NOT carry `.float-group`,
 *      whose `float-drift` keyframe animates the same property this loop
 *      writes.
 *
 * `useShardField`'s targets are closure-private and are reset by its own
 * pointer handlers, so orbit positions could not be pushed through it even if
 * that were desirable. The layering is the same idiom `ShardPlayer` uses for
 * its spread, and it is what keeps the shards interactive — they still tilt
 * and take the specular highlight while they orbit. The dust does not: it is
 * `pointer-events: none` and carries no handler, because "non interactable"
 * was the instruction and eighty hit-test targets crossing the cursor would
 * make the ten that *are* interactive impossible to hit.
 *
 * **The wrapper carries its own perspective.** `perspective` as a CSS
 * property gives `.shard` inside it the depth `useShardField`'s rotateX/Y
 * needs, and the `perspective()` transform *function* in the wrapper's own
 * transform gives the wrapper's tumble the same. Neither depends on an
 * ancestor, which is what lets the scene layer stay flat — and it has to stay
 * flat, because a `preserve-3d` parent sorts its children by their 3D
 * position and ignores z-index, which is the one thing here that must be
 * obeyed exactly.
 */

/**
 * Ring radii, in % of the field. Wider than tall because the ring is tilted
 * away from the viewer — that tilt is the whole source of the depth.
 *
 * Portrait gets a wider ring, and it is not a taste call: the ring's radius is
 * a percentage of the *width*, the orb's size is capped in `vw`, and the card
 * in the middle is `w-1/2 max-w-[16rem]`. At 27% of a 414px phone the ring
 * radius lands inside the card, so every fragment would orbit behind it and
 * the whole effect would be invisible on a phone while looking right on a
 * desktop.
 */
const RING = {
  desktop: { rx: 27, ry: 13 },
  mobile: { rx: 44, ry: 10 },
} as const;

/** Specks of dust. Enough to read as a band, few enough that a hundred-odd transform writes a frame stays cheap. */
const DEBRIS_COUNT = { desktop: 76, mobile: 44 };

/** Where the scene sits when there is no anchor to measure — the middle of the field. */
function fallbackCentre(setKey: SetKey): OrbitCentre {
  return { x: 50, y: 50, ...RING[setKey] };
}

interface OrbitFieldProps {
  setKey: SetKey;
  /**
   * How far the run has got, 0..1, from counted facts — never a timer.
   * Drives how many shards have left the ring for the card.
   */
  progress: number;
  /** False before the orb has finished rising, so the gather starts when there is something to gather toward. */
  active: boolean;
  /** The board: the orb stays visible behind the sealed slab, "but upon first crack it disappears". */
  cracked: boolean;
  /**
   * A CSS selector for the element the scene centres on — the video card, so
   * the orb sits behind the thing being built and the shards dock into it
   * (operator direction, 2026-09-05: "make sure the orb is in the center as
   * the video card gets slowly formed").
   *
   * Measured rather than guessed. The centre used to be a hard-coded 50%/34%,
   * which is a different point from the card's centre on every viewport
   * height there is, so the shards converged on a spot the card was not at.
   */
  anchor: string;
}

/**
 * Whether this operator has asked for less motion — as React state, because
 * the loop below has to be *re-run* on a progress change when they have, and
 * an effect cannot depend on something it reads out of `matchMedia` itself.
 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = (): void => setReduced(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return reduced;
}

export function OrbitField({ setKey, progress, active, cracked, anchor }: OrbitFieldProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const orbRef = useRef<HTMLDivElement>(null);
  const ready = useAtlasReady(setKey, preloadAtlas);
  const placements = useMemo(() => edgeLayout(setKey), [setKey]);
  const debris = useMemo(() => debrisSeeds(DEBRIS_COUNT[setKey]), [setKey]);
  const ring = RING[setKey];

  // The spring loop still owns each `.shard`. `hoverLift` is small for the
  // same reason `EdgeFrame` keeps it small: a fragment leaping forward as the
  // cursor crosses it on the way somewhere else is noise, and here the cursor
  // is crossing a moving field.
  useShardField(rootRef, placements, { ready, hoverLift: 30 });

  const seeds = useMemo<OrbitSeed[]>(
    () =>
      placements.map((p, index) => ({
        fromX: p.x + p.w / 2,
        fromY: p.y + p.h / 2,
        index,
        count: placements.length,
        span: Math.max(p.w, p.h),
      })),
    [placements],
  );

  /**
   * `progress` is read through a ref inside the loop rather than being a
   * dependency of it.
   *
   * Restarting the rAF loop every time the poll returns would reset `start`,
   * and the orbit would jump back to its gather position every five seconds.
   * The loop runs once for the life of the screen; the value it reads changes
   * underneath it.
   */
  const progressRef = useRef(progress);
  progressRef.current = progress;

  const reducedMotion = usePrefersReducedMotion();

  /**
   * The one case where `progress` IS a dependency of the loop.
   *
   * With reduced motion the loop places everything once and stops — that is
   * the whole point of it — so nothing would ever re-place a shard when a
   * milestone lands, and the ring would sit frozen at its opening pose for
   * the length of the render while the card in front of it healed. Re-running
   * the effect is what places them again.
   *
   * Frozen at 0 when motion is allowed, deliberately: there the rAF loop must
   * NOT be torn down every time the five-second poll returns, because that
   * resets `start` and throws the orbit back to its gather position.
   */
  const staticProgress = reducedMotion ? progress : 0;

  useEffect(() => {
    if (!active) return;
    const root = rootRef.current;
    if (root === null) return;

    // NOT gated on `ready`. The fragments are, because they cannot be placed
    // before the atlas has decoded — but the orb has to be centred from the
    // first frame it is visible, and the rise transition covers `transform`
    // only. Waiting for the atlas here left it in the corner of the field
    // until the sprite landed and then jumped it to the middle with no
    // transition to hide the move. The effect re-runs when `ready` flips and
    // picks the fragments up then, restarting the gather from the moment
    // there is something to gather.
    const wrappers = ready ? Array.from(root.querySelectorAll<HTMLElement>("[data-orbit-shard]")) : [];
    const specks = Array.from(root.querySelectorAll<HTMLElement>("[data-orbit-debris]"));

    // Honour the same contract the rest of the glass does: with reduced
    // motion the shards take their ring positions and hold them, so the
    // composition is right and nothing moves. `shards.css` turns off the
    // spring's transitions and the drift keyframes for the same reason.
    let frame = 0;
    const start = performance.now();
    let previous = start;

    /**
     * How far each shard actually is into its dock, as opposed to how far it
     * is *entitled* to be.
     *
     * `dockedFor` is a step function: the moment a milestone lands, one
     * shard's target goes from 0 to 1 and the next one's from 0 to a
     * fraction. Read straight into the pose that is a teleport — the fragment
     * was on the ring in one frame and inside the card in the next, and the
     * operator's "only get slowly big as a stage finishes and comes to form
     * the video card" never happens on screen at all.
     *
     * So the target is counted and the *approach* is eased, which is the same
     * split `ForgePane` already makes: its fracture is a counted number and a
     * CSS transition carries it. Nothing here invents progress — this value
     * only ever moves toward one `dockedFor` returned, and with reduced
     * motion it is simply set to it.
     */
    const settled = new Float64Array(wrappers.length);
    let seeded = false;

    /** Seconds for the approach to close ~63% of the remaining distance. Slow enough to read as growth, short enough that six of them fit in a render. */
    const DOCK_TAU = 1.15;

    /** Written only when it changes: `zIndex` is a string assignment, and the value flips twice a revolution rather than sixty times a second. */
    const layers = new Map<HTMLElement, string>();
    const layer = (el: HTMLElement, depth: number): void => {
      const z = depth < 0 ? "1" : "3";
      if (layers.get(el) === z) return;
      layers.set(el, z);
      el.style.zIndex = z;
    };

    /**
     * `orbitPose` works in **% of the field**, but a `translate` percentage on
     * the wrapper resolves against the *wrapper's own box* — and these boxes
     * are 6-27% wide and wildly different from each other, so writing the
     * offsets as percentages would send every shard a different distance for
     * the same number. They are converted to pixels here, against the field's
     * measured size.
     *
     * Measured once per frame rather than cached: this is two
     * `getBoundingClientRect` calls on elements whose geometry only changes on
     * resize, and the alternative is a resize listener plus a layout observer
     * that both have to stay in step with a loop that already runs every
     * frame. The anchor is measured for the same reason — the card it centres
     * on changes size when the export lands and the pane becomes a player.
     */
    const tick = (now: number): void => {
      const elapsed = reducedMotion ? 0 : (now - start) / 1000;
      // Frame-rate independent: the same easing on a 60 Hz laptop and a
      // 120 Hz display, rather than one that docks twice as fast on the
      // second because it is written per frame.
      const dt = Math.min(0.1, (now - previous) / 1000);
      previous = now;
      const { width, height, left, top } = root.getBoundingClientRect();

      // Where the scene is centred, in % of the field. The anchor is the card
      // itself, so the orb, the ring and the dock target are one point.
      const target = document.querySelector(anchor);
      const box = target?.getBoundingClientRect();
      const centre: OrbitCentre =
        box === undefined || box.width === 0
          ? fallbackCentre(setKey)
          : { x: ((box.left + box.width / 2 - left) / width) * 100, y: ((box.top + box.height / 2 - top) / height) * 100, ...ring };

      const orb = orbRef.current;
      if (orb !== null) {
        orb.style.left = `${centre.x.toFixed(2)}%`;
        orb.style.top = `${centre.y.toFixed(2)}%`;
      }

      for (const [i, wrapper] of wrappers.entries()) {
        const seed = seeds[i];
        if (seed === undefined) continue;
        const target = dockedFor(i, wrappers.length, progressRef.current);
        // The first frame takes the target whole. A run resumed mid-flight —
        // a reload with four milestones already true — must open with those
        // four shards docked, not spend five seconds docking them as though
        // they had just happened.
        settled[i] = !seeded || reducedMotion ? target : settled[i] + (target - settled[i]) * (1 - Math.exp(-dt / DOCK_TAU));
        // With reduced motion the gather is complete and the ring is
        // stationary: `GATHER_S` seconds in, at angle zero.
        const pose = orbitPose(seed, centre, reducedMotion ? GATHER_S : elapsed, settled[i]);
        wrapper.style.transform =
          `translate3d(${((pose.dx / 100) * width).toFixed(1)}px, ${((pose.dy / 100) * height).toFixed(1)}px, 0)` +
          ` perspective(900px) rotateX(${pose.rotX.toFixed(1)}deg) rotateY(${pose.rotY.toFixed(1)}deg) rotateZ(${pose.rotZ.toFixed(1)}deg)` +
          ` scale(${pose.scale.toFixed(3)})`;
        wrapper.style.opacity = pose.opacity.toFixed(3);
        layer(wrapper, pose.depth);
      }

      for (const [i, speck] of specks.entries()) {
        const seed = debris[i];
        if (seed === undefined) continue;
        const pose = debrisPose(seed, centre, reducedMotion ? 0 : elapsed);
        // Half its own size back, because the pose is where the speck's
        // *centre* belongs and the element is anchored at its top-left. Done
        // here rather than with a `translate: -50% -50%` so there is exactly
        // one transform on this element and no dependence on the order the
        // independent transform properties compose in.
        const x = (pose.x / 100) * width - seed.size / 2;
        const y = (pose.y / 100) * height - seed.size / 2;
        speck.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) scale(${pose.scale.toFixed(3)})`;
        speck.style.opacity = pose.opacity.toFixed(3);
        layer(speck, pose.depth);
      }

      seeded = true;
      if (!reducedMotion) frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [ready, active, seeds, debris, anchor, ring, setKey, reducedMotion, staticProgress]);

  return (
    <div ref={rootRef} className="fixed inset-0 z-0 overflow-hidden" aria-hidden="true">
      {/*
        The orb, at the scene's centre and between the two halves of the ring.

        **How it sits on a white page.** The vendored component renders into
        an opaque WebGL canvas (`alpha: false`), so it is always a filled
        rectangle. Two things were needed, both outside that file:

        1. `background: "#ffffff"`, its own documented option. Passing
           `"transparent"` is not a colour three.js can parse — it warned and
           left the canvas white anyway, which is how the square was found
           (`THREE.Color: Unknown color transparent`, 2026-09-04).
        2. A radial mask on the wrapper (`.orb-rise` in shards.css) to cut the
           rectangle away. `mix-blend-mode: multiply` — the trick
           `Spheres.tsx` uses on this same ground — cannot work here, because
           blending only reaches the backdrop inside its own stacking context
           and the spheres are a fixed sibling far below.

        `left`/`top` are written by the loop from the measured anchor; the
        rise is a CSS transition on `.orb-rise`, so the two never fight over
        the same property.
      */}
      <div
        ref={orbRef}
        className={`orb-rise pointer-events-none absolute ${active ? "orb-rise--up" : ""} ${cracked ? "orb-rise--gone" : ""}`}
        /* The centre of the field until the loop has measured the card. The
           card is horizontally centred, so `left` is already right and only
           `top` is refined — a fallback that is close rather than a corner. */
        style={{ zIndex: 2, left: "50%", top: "50%" }}
      >
        <OrbLazy config={{ background: "#ffffff", rotationSpeed: 0.22 }} />
      </div>

      {/* The dust. No handlers, no `data-shard`, nothing for `useShardField`
          to find — these are painted specks, and the only thing written to
          them is a transform. */}
      {debris.map((seed, i) => (
        <i
          key={`debris-${i}`}
          data-orbit-debris
          className="orbit-debris"
          style={{ width: `${seed.size.toFixed(2)}px`, height: `${seed.size.toFixed(2)}px`, zIndex: 1 }}
        />
      ))}

      {ready &&
        placements.map((p) => (
          /* The wrapper carries the orbit; the Shard inside carries the
             spring. The wrapper sits at the shard's own edge position and is
             moved from there in pixels — see the loop above for why the
             conversion out of field-percent has to happen there. */
          <div
            key={p.key}
            data-orbit-shard
            className="orbit-shard absolute"
            style={{ left: `${p.x}%`, top: `${p.y}%`, width: `${p.w}%`, height: `${p.h}%`, zIndex: 1 }}
          >
            {/* `shard--lit` + a violet wash rather than a new rule: at a
                twentieth of their edge size these fragments are pale
                wireframes on a white ground, and `--lit` is the vocabulary
                this surface already has for "this piece is live". The colour
                is the same `--violet` the card under them glows with. */}
            <Shard
              pieceId={p.pieceId}
              setKey={p.setKey}
              className="shard--edge shard--orbit shard--lit"
              wash="var(--violet)"
              halo="rgba(120, 100, 255, 0.42)"
              style={{ left: "0%", top: "0%", width: "100%", height: "100%" }}
            />
          </div>
        ))}
    </div>
  );
}
