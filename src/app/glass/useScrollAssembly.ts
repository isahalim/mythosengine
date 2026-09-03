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
  /** How many fragments settle before the payoff — the rest of the timeline is the tail. */
  assemblyEnd?: number;
  /** Called with 0..1 on every frame the progress actually changes. */
  onProgress?: (p: number) => void;
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** Smoothstep. Linear scroll feels mechanical; this gives each fragment a soft arrival. */
const ease = (t: number): number => t * t * (3 - 2 * t);

/**
 * How much of a fragment's window is spent fading in, as opposed to flying
 * into place.
 *
 * This number is the whole reason the first version read as broken. Opacity
 * and position used to share one curve over a window 42% of the timeline
 * wide, so the first fragment sat at **opacity 0.01** when the reader
 * arrived and had only reached 0.26 by the second stage — a screen and a
 * half of scrolling against a blank pane, under a caption confidently
 * announcing "STAGE 1 OF 7". Nothing was broken and it was indistinguishable
 * from broken.
 *
 * So the two are separated. A fragment reaches full opacity in the first
 * third of its window and spends the rest travelling: it announces itself
 * immediately, then earns its place. Scrolling always does something
 * visible.
 */
const FADE_FRACTION = 0.34;

/** Never fully invisible once its window has opened — the first frame of a fragment's life is still a fragment. */
const MIN_VISIBLE = 0.12;

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
  { assemblyEnd = 0.82, onProgress }: AssemblyOptions = {},
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

    // Each fragment gets its own slice of the assembly, and lands inside it.
    // The slices are what ties the motion to the captions: the reader is told
    // "STAGE 3 OF 7" and a fragment arrives while they are being told it. The
    // window is a little wider than the slice so two neighbours overlap in
    // flight and the pane assembles continuously rather than in ticks.
    const slice = assemblyEnd / shards.length;
    const settleWindow = slice * 1.35;
    const startOf = (i: number): number => i * slice;

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
          const raw = reduced ? 1 : clamp01((p - startOf(i)) / settleWindow);
          const local = ease(raw);
          // Fast in, slow into place — see FADE_FRACTION.
          const shown = raw <= 0 ? 0 : Math.max(MIN_VISIBLE, ease(clamp01(raw / FADE_FRACTION)));
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
          el.style.opacity = shown.toFixed(3);
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
  }, [trackRef, stageRef, count, assemblyEnd]);
}
