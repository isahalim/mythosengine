import { useEffect, useRef } from "react";
import { OrbLazy } from "../orb/OrbLazy.tsx";

/**
 * The gradient orb, behind the card being built.
 *
 * **What used to be here.** Until 2026-09-05 this file was `OrbitField`: the
 * orb plus ten edge fragments gathered off the page borders, tumbling on a
 * tilted ring, half behind the orb and half in front, trailing seventy-six
 * specks of dust, each fragment extruded into a slab of eight masked copies
 * and docking into the card as milestones landed. All of it is gone by
 * operator direction — "I want to make the design more simple, so completely
 * remove the orbiting glass shards and debris". The card is still built one
 * fragment per counted fact; those fragments are `ForgePane`'s own, free
 * floating in place, and nothing flies into them.
 *
 * What survives is the one thing the orbit existed to sit at the centre of.
 * The orb rises when the screen opens, stays centred on the card for the
 * length of the run, and fades out when the card is whole.
 *
 * **Why the orb is a fixed layer of its own rather than a box inside
 * `StageBuilding`'s column.** That column scrolls and clips (the finished
 * state is a player, four buttons and a metadata sheet), and the orb is
 * `min(38vw, 34rem)` across — several times the card it sits behind. Inside
 * the column it would be cut to the card's own width on every side. Here it
 * is behind everything, at `z-0`, and the column paints over it at `z-10`.
 *
 * **The centre is measured, never assumed.** `anchor` is a selector for the
 * card itself, and the loop reads its box every frame: it is a `ForgePane`
 * at one moment and a `ShardPlayer` at the next, in a column that scrolls
 * under the operator's finger. A hard-coded percentage was right on exactly
 * one viewport.
 */

interface OrbFieldProps {
  /** False before the screen has settled, so the rise starts from a mounted element rather than from nothing. */
  active: boolean;
  /**
   * True once the card is whole — the export exists (operator direction,
   * 2026-09-05: "when the glass video card gets healed, fade out the gradient
   * orb at that time. Dont wait for the first click/shatter to remove it").
   *
   * It used to be the player's first crack, which is an act the operator
   * performs: a run that finished while nobody was watching kept a 34rem orb
   * burning through the finished video indefinitely.
   */
  healed: boolean;
  /** A CSS selector for the element to centre on — the video card. */
  anchor: string;
}

export function OrbField({ active, healed, anchor }: OrbFieldProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const orbRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active) return;
    const root = rootRef.current;
    if (root === null) return;

    let frame = 0;

    /**
     * Two `getBoundingClientRect` calls a frame, deliberately, rather than a
     * cached measurement kept in step by a resize listener and a layout
     * observer: the card changes size when the export lands, and it moves
     * whenever the column under it scrolls.
     *
     * `left`/`top` only. The rise is a CSS transition on `.orb-rise`, which
     * owns `transform`, `width`, `height` and `opacity` — the two never
     * write the same property.
     */
    const tick = (): void => {
      const orb = orbRef.current;
      if (orb !== null) {
        const { width, height, left, top } = root.getBoundingClientRect();
        const box = document.querySelector(anchor)?.getBoundingClientRect();
        // The middle of the field until there is a card to measure. The card
        // is horizontally centred, so only `top` is ever really refined.
        const x = box === undefined || box.width === 0 ? 50 : ((box.left + box.width / 2 - left) / width) * 100;
        const y = box === undefined || box.width === 0 ? 50 : ((box.top + box.height / 2 - top) / height) * 100;
        orb.style.left = `${x.toFixed(2)}%`;
        orb.style.top = `${y.toFixed(2)}%`;
      }
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active, anchor]);

  return (
    <div ref={rootRef} className="fixed inset-0 z-0 overflow-hidden" aria-hidden="true">
      {/*
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
      */}
      <div
        ref={orbRef}
        className={`orb-rise pointer-events-none absolute ${active ? "orb-rise--up" : ""} ${healed ? "orb-rise--gone" : ""}`}
        style={{ left: "50%", top: "50%" }}
      >
        <OrbLazy config={{ background: "#ffffff", rotationSpeed: 0.22 }} />
      </div>
    </div>
  );
}
