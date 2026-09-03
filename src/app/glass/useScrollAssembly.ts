/**
 * Scroll-driven assembly: fragments fly in from depth and settle into a
 * finished pane as the reader scrolls.
 *
 * **Why this is hand-written.** Every scroll-3D guide reaches for
 * GSAP ScrollTrigger, Lenis or three.js, and all three are the wrong trade
 * here. CLAUDE.md forbids adding a framework without operator instruction,
 * the whole effect is two lerps and a rAF loop, and the glass is already a
 * DOM-and-CSS surface (`useShardField`) rather than a canvas — dropping a
 * WebGL renderer beside it would mean maintaining two glass implementations
 * that have to look identical. What is borrowed from those libraries is the
 * *shape* of the technique, which is not theirs and is worth stating:
 *
 * - **A sticky viewport over a tall track.** The stage is `position: sticky`
 *   inside a container several screens tall, so scrolling scrubs a timeline
 *   instead of moving the content. Nothing here listens for wheel events or
 *   hijacks the scrollbar: the reader keeps native scrolling, including
 *   momentum, keyboard paging and find-in-page.
 * - **Progress is read, never accumulated.** `p` is derived from the track's
 *   own `getBoundingClientRect()` every frame. Integrating deltas drifts,
 *   and breaks completely on an anchor jump or a restored scroll position.
 * - **Staggered per-element windows.** Each fragment settles over its own
 *   slice of the timeline, so the pane assembles piece by piece rather than
 *   every shard arriving at once.
 * - **Writes happen in rAF, reads in the scroll handler.** The listener only
 *   records that something moved; all layout reads and style writes happen
 *   once per frame, which is what keeps this off the main thread's critical
 *   path.
 */
import { useEffect, useRef, type RefObject } from "react";
import { jitter } from "./geometry.ts";

export interface AssemblyOptions {
  /** How much of the timeline one fragment takes to settle, as a fraction of the whole. */
  window?: number;
  /** Fraction of the timeline reserved after the last fragment lands, for the payoff. */
  tail?: number;
  /** Called with 0..1 on every frame the progress actually changes. */
  onProgress?: (p: number) => void;
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** Smoothstep. Linear scroll feels mechanical; this gives each fragment a soft arrival. */
const ease = (t: number): number => t * t * (3 - 2 * t);

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * @param trackRef  the tall scroll container whose extent is the timeline
 * @param count     how many `[data-assembly-shard]` elements are inside `stageRef`
 */
export function useScrollAssembly(
  trackRef: RefObject<HTMLElement | null>,
  stageRef: RefObject<HTMLElement | null>,
  count: number,
  { window: settleWindow = 0.42, tail = 0.18, onProgress }: AssemblyOptions = {},
): void {
  // Held in a ref so changing the callback does not tear down the loop and
  // restart the animation mid-scroll.
  const progressRef = useRef(onProgress);
  progressRef.current = onProgress;

  useEffect(() => {
    const track = trackRef.current;
    const stage = stageRef.current;
    if (!track || !stage || count === 0) return;

    const shards = Array.from(stage.querySelectorAll<HTMLElement>("[data-assembly-shard]"));
    if (shards.length === 0) return;

    const reduced = prefersReducedMotion();
    let frame = 0;
    let last = -1;

    // Each fragment's slice of the timeline. Spread across everything before
    // the tail, so the last one lands with room to spare and the payoff is
    // not competing with a shard still in flight.
    const runway = Math.max(0.0001, 1 - tail - settleWindow);
    const startOf = (i: number): number => (shards.length === 1 ? 0 : (i / (shards.length - 1)) * runway);

    const render = (): void => {
      frame = 0;
      const rect = track.getBoundingClientRect();
      // 0 when the track's top reaches the top of the viewport, 1 when its
      // bottom does — i.e. the whole time the sticky stage is pinned.
      const scrollable = rect.height - window.innerHeight;
      const p = scrollable <= 0 ? 0 : clamp01(-rect.top / scrollable);

      if (p !== last) {
        last = p;
        progressRef.current?.(p);

        shards.forEach((el, i) => {
          const local = reduced ? 1 : ease(clamp01((p - startOf(i)) / settleWindow));
          // Where this fragment comes in from. Deterministic per index, so
          // the assembly is identical on every visit and on a resize —
          // `jitter` is the same helper the resting poses use.
          const j = jitter(i + 1);
          const dx = j.tx * 24;
          const dy = j.ty * 18 - 140;
          const rot = j.rot * 26;

          const tx = dx * (1 - local);
          const ty = dy * (1 - local);
          const tz = -900 * (1 - local);
          const rz = rot * (1 - local);
          const rx = 42 * (1 - local);
          const scale = 0.72 + 0.28 * local;

          el.style.transform = `translate3d(${tx.toFixed(2)}px, ${ty.toFixed(2)}px, ${tz.toFixed(1)}px) rotateX(${rx.toFixed(2)}deg) rotateZ(${rz.toFixed(2)}deg) scale(${scale.toFixed(3)})`;
          el.style.opacity = local.toFixed(3);
        });
      }
    };

    const schedule = (): void => {
      if (frame === 0) frame = requestAnimationFrame(render);
    };

    render();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [trackRef, stageRef, count, settleWindow, tail]);
}
