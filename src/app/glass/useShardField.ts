/**
 * The one rAF spring loop that drives every fragment on screen.
 *
 * Logic verbatim from "Broken by Design — Shattered Glass Hero"
 * (@gughigug, 21st.dev) — same k=0.12 critically-soft follow, same
 * per-ring parallax depths, same hover pose (tz +92, scale 1.035, tilt
 * from the cursor's position inside the fragment), same
 * assemble-from-the-centre entrance. Board 1 asks for exactly that
 * behaviour ("there is also 3D interactions where the shards tilt when
 * cursor interacts"), so it is reproduced rather than reinvented.
 *
 * Generalised in one way only: the source hard-coded the 16 pane pieces,
 * and this app also floats fragments loose in the middle (stage 2) and
 * frames the viewport with them (stages 2-6). So placements are passed in
 * and the loop is agnostic about where they sit.
 *
 * `placements` is a dependency of the effect that installs the loop, so
 * callers MUST hand it a stable (useMemo'd) array — re-creating it every
 * render would tear the listeners down and replay the entrance on every
 * unrelated state change.
 *
 * The source's hover audio (a synthesised crack tick and its mute toggle)
 * is deliberately not carried over: the boards never ask for sound, and
 * sixteen ticks as a cursor crosses a pane is noise, not feedback.
 */
import { useEffect, type RefObject } from "react";
import { baseOf, toTransform, type SetKey, type SpringState } from "./geometry.ts";

export interface Placement {
  /** Stable identity for this fragment on screen — also its React key and its spring slot. */
  key: string;
  /** Which fragment of the atlas to cut. */
  pieceId: string;
  setKey: SetKey;
  /** Position and size, as a % of the field. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Where it flies in from, as a % of the field — the entrance pushes outward from the centre. */
  cx: number;
  cy: number;
  /** Depth ring: 0 is nearest (most parallax), 2 is furthest. */
  ring: number;
  z: number;
}

export interface ShardFieldOptions {
  /** Cursor tilt/parallax. False leaves every fragment at its resting pose. */
  interactive?: boolean;
  /** Play the assemble-from-the-centre entrance on mount. */
  entrance?: boolean;
  /** Gate the whole loop until the atlas has decoded, so nothing animates against a blank sprite. */
  ready?: boolean;
  /** How far a fragment lifts toward the cursor on hover. 0 disables the per-shard hover pose but keeps field parallax. */
  hoverLift?: number;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function useShardField(
  rootRef: RefObject<HTMLElement | null>,
  placements: Placement[],
  { interactive = true, entrance = true, ready = true, hoverLift = 92 }: ShardFieldOptions = {},
): void {
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !ready) return;

    const reduced = prefersReducedMotion();
    const shards = Array.from(root.querySelectorAll<HTMLElement>("[data-shard]"));
    if (shards.length === 0) return;

    // The resting pose is the floor state — set it inline so the entrance
    // (fill: backwards) lands exactly on it rather than snapping afterward.
    const restOf = (i: number): SpringState => baseOf(placements[i].pieceId, i + 1);
    shards.forEach((el, i) => {
      el.style.transform = toTransform(restOf(i));
    });

    if (entrance && !reduced) {
      shards.forEach((el, i) => {
        const p = placements[i];
        const rest = toTransform(restOf(i));
        const dx = p.cx - 50;
        const dy = p.cy - 50;
        const dist = Math.hypot(dx, dy);
        const ux = dx / (dist || 1);
        const uy = dy / (dist || 1);
        el.animate(
          [
            {
              opacity: 0,
              transform: `translate3d(${ux * 110}px, ${uy * 110}px, 280px) rotateX(${uy * -12}deg) rotateY(${ux * 12}deg)`,
              filter: "brightness(1.6) blur(2px)",
            },
            { opacity: 1, transform: rest, filter: "brightness(1) blur(0px)", offset: 0.72 },
            { opacity: 1, transform: rest, filter: "none" },
          ],
          // All pieces land together — the composition assembles in one
          // beat instead of trickling in, which is what makes it read as
          // a single impact rather than a stagger.
          { duration: 1400, delay: 180, easing: "cubic-bezier(.16,1,.3,1)", fill: "backwards" },
        );
      });
    }

    if (!interactive || reduced) return;

    const cur: SpringState[] = shards.map((_, i) => restOf(i));
    const tgt: SpringState[] = shards.map((_, i) => restOf(i));
    const hovered = new Set<number>();

    let raf = 0;
    let running = false;
    let globalX = 0;
    let globalY = 0;

    const tick = (): void => {
      let alive = false;
      const k = 0.12;
      for (let i = 0; i < shards.length; i++) {
        const c = cur[i];
        const t = tgt[i];
        c.rx += (t.rx - c.rx) * k;
        c.ry += (t.ry - c.ry) * k;
        c.tz += (t.tz - c.tz) * k;
        c.px += (t.px - c.px) * k;
        c.py += (t.py - c.py) * k;
        c.sc += (t.sc - c.sc) * k;
        const d =
          Math.abs(t.rx - c.rx) + Math.abs(t.ry - c.ry) + Math.abs(t.tz - c.tz) + Math.abs(t.px - c.px) + Math.abs(t.py - c.py);
        if (d > 0.01) alive = true;
        shards[i].style.transform = toTransform(c);
      }
      if (alive) raf = requestAnimationFrame(tick);
      else running = false;
    };

    // The loop sleeps when everything has settled and is woken by input —
    // a static pane costs no frames.
    const wake = (): void => {
      if (running) return;
      running = true;
      raf = requestAnimationFrame(tick);
    };

    const setParallax = (): void => {
      for (let i = 0; i < shards.length; i++) {
        if (hovered.has(i)) continue;
        const b = restOf(i);
        const depth = 1 - placements[i].ring * 0.32;
        tgt[i].px = b.px - globalX * 24 * depth;
        tgt[i].py = b.py - globalY * 18 * depth;
        tgt[i].rx = b.rx + globalY * 3.2 * depth;
        tgt[i].ry = b.ry - globalX * 4 * depth;
        tgt[i].tz = b.tz;
        tgt[i].sc = b.sc;
      }
    };

    const onRootMove = (e: PointerEvent): void => {
      const r = root.getBoundingClientRect();
      globalX = (e.clientX - r.left) / r.width - 0.5;
      globalY = (e.clientY - r.top) / r.height - 0.5;
      setParallax();
      wake();
    };

    const onRootLeave = (): void => {
      globalX = 0;
      globalY = 0;
      tgt.forEach((t, i) => {
        if (!hovered.has(i)) Object.assign(t, restOf(i));
      });
      wake();
    };

    root.addEventListener("pointermove", onRootMove);
    root.addEventListener("pointerleave", onRootLeave);

    const cleanups: (() => void)[] = [
      () => root.removeEventListener("pointermove", onRootMove),
      () => root.removeEventListener("pointerleave", onRootLeave),
    ];

    shards.forEach((el, i) => {
      const onMove = (e: PointerEvent): void => {
        const r = el.getBoundingClientRect();
        const lx = (e.clientX - r.left) / r.width - 0.5;
        const ly = (e.clientY - r.top) / r.height - 0.5;
        const b = restOf(i);
        tgt[i].rx = b.rx - ly * 14;
        tgt[i].ry = b.ry + lx * 17;
        tgt[i].tz = b.tz + hoverLift;
        tgt[i].sc = hoverLift > 0 ? 1.035 : 1;
        // Drives the specular highlight's centre (.shard-spec in shards.css).
        el.style.setProperty("--mx", `${((lx + 0.5) * 100).toFixed(1)}%`);
        el.style.setProperty("--my", `${((ly + 0.5) * 100).toFixed(1)}%`);
        wake();
      };
      const onEnter = (): void => {
        hovered.add(i);
        el.classList.add("shard--hot");
      };
      const onLeave = (): void => {
        hovered.delete(i);
        el.classList.remove("shard--hot");
        Object.assign(tgt[i], restOf(i));
        setParallax();
        wake();
      };
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerenter", onEnter);
      el.addEventListener("pointerleave", onLeave);
      cleanups.push(() => {
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerenter", onEnter);
        el.removeEventListener("pointerleave", onLeave);
      });
    });

    return () => {
      cancelAnimationFrame(raf);
      cleanups.forEach((fn) => fn());
    };
  }, [rootRef, placements, interactive, entrance, ready, hoverLift]);
}
