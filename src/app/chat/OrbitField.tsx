import { useEffect, useMemo, useRef } from "react";
import { preloadAtlas, type SetKey } from "../glass/geometry.ts";
import { edgeLayout } from "../glass/layouts.ts";
import { Shard } from "../glass/Shard.tsx";
import { useShardField } from "../glass/useShardField.ts";
import { useAtlasReady } from "../useAtlasReady.ts";
import { dockedFor, GATHER_S, orbitPose, type OrbitCentre, type OrbitSeed } from "./orbit.ts";

/**
 * The shards the orb gathers, and the ring they orbit on.
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
 * **Three transform layers, three owners, and none of them share an
 * element.** This is the load-bearing detail:
 *
 *   1. `.orbit-shard` (the wrapper) — written here, every frame, from
 *      `orbitPose`. The orbit, the gather, and the dock.
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
 * and take the specular highlight while they orbit.
 */

/** Where the orb sits and how wide the ring is, in % of the field. Matches `StageBuilding`'s own orb placement. */
const CENTRE: OrbitCentre = { x: 50, y: 34, rx: 26, ry: 15 };

interface OrbitFieldProps {
  setKey: SetKey;
  /**
   * How far the run has got, 0..1, from counted facts — never a timer.
   * Drives how many shards have left the ring for the card.
   */
  progress: number;
  /** False before the orb has finished rising, so the gather starts when there is something to gather toward. */
  active: boolean;
}

export function OrbitField({ setKey, progress, active }: OrbitFieldProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const ready = useAtlasReady(setKey, preloadAtlas);
  const placements = useMemo(() => edgeLayout(setKey), [setKey]);

  // The spring loop still owns each `.shard`. `hoverLift` is small for the
  // same reason `EdgeFrame` keeps it small: a fragment leaping forward as the
  // cursor crosses it on the way somewhere else is noise, and here the cursor
  // is crossing a moving field.
  useShardField(rootRef, placements, { ready, hoverLift: 30 });

  const seeds = useMemo<OrbitSeed[]>(
    () => placements.map((p, index) => ({ fromX: p.x + p.w / 2, fromY: p.y + p.h / 2, index, count: placements.length })),
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

  useEffect(() => {
    if (!ready || !active) return;
    const root = rootRef.current;
    if (root === null) return;

    const wrappers = Array.from(root.querySelectorAll<HTMLElement>("[data-orbit-shard]"));
    if (wrappers.length === 0) return;

    // Honour the same contract the rest of the glass does: with reduced
    // motion the shards take their ring positions and hold them, so the
    // composition is right and nothing moves. `shards.css` turns off the
    // spring's transitions and the drift keyframes for the same reason.
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let frame = 0;
    const start = performance.now();

    /**
     * `orbitPose` works in **% of the field**, but a `translate` percentage on
     * the wrapper resolves against the *wrapper's own box* — and these boxes
     * are 6-27% wide and wildly different from each other, so writing the
     * offsets as percentages would send every shard a different distance for
     * the same number. They are converted to pixels here, against the field's
     * measured size.
     *
     * Measured once per frame rather than cached: this is one
     * `getBoundingClientRect` on an element whose size only changes on
     * resize, and the alternative is a resize listener that has to stay in
     * step with a loop that already runs every frame.
     */
    const tick = (now: number): void => {
      const elapsed = reduced ? 0 : (now - start) / 1000;
      const { width, height } = root.getBoundingClientRect();

      for (const [i, wrapper] of wrappers.entries()) {
        const seed = seeds[i];
        if (seed === undefined) continue;
        // With reduced motion the gather is complete and the ring is
        // stationary: `GATHER_S` seconds in, at angle zero.
        const pose = orbitPose(seed, CENTRE, reduced ? GATHER_S : elapsed, dockedFor(i, wrappers.length, progressRef.current));
        wrapper.style.transform = `translate3d(${((pose.dx / 100) * width).toFixed(1)}px, ${((pose.dy / 100) * height).toFixed(1)}px, 0) scale(${pose.scale.toFixed(3)})`;
        wrapper.style.opacity = pose.opacity.toFixed(3);
      }
      if (!reduced) frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [ready, active, seeds]);

  return (
    <div ref={rootRef} className="fixed inset-0 z-0 overflow-hidden" style={{ perspective: "1250px" }} aria-hidden="true">
      <div className="absolute inset-0" style={{ transformStyle: "preserve-3d" }}>
        {ready &&
          placements.map((p) => (
            /* The wrapper carries the orbit; the Shard inside carries the
               spring. The wrapper sits at the shard's own edge position and
               is moved from there in pixels — see the loop above for why the
               conversion out of field-percent has to happen there. */
            <div
              key={p.key}
              data-orbit-shard
              className="orbit-shard absolute"
              style={{ left: `${p.x}%`, top: `${p.y}%`, width: `${p.w}%`, height: `${p.h}%`, zIndex: p.z }}
            >
              <Shard pieceId={p.pieceId} setKey={p.setKey} className="shard--edge" style={{ left: "0%", top: "0%", width: "100%", height: "100%" }} />
            </div>
          ))}
      </div>
    </div>
  );
}
