/**
 * The choosing gesture: a ring of choices around the video's own glass.
 *
 * Hovering a choice previews its colour on the ring and names it in the
 * centre, so the hue a fragment is about to take is visible before it is
 * committed.
 *
 * The caustic ray fan that used to sit behind the ring was removed on
 * operator direction (2026-08-31) — it read as decoration over the top of
 * the thing being chosen rather than as light falling on it.
 *
 * Used by stage 3 (topics) and stage 4 (ideas). Board 2 on stage 4: "now a
 * larger piece of glass shard gets added (same design principle)" — so it
 * is one component, not two.
 */
import { useState, type CSSProperties, type ReactNode } from "react";

export interface DialItem {
  id: string;
  /** The short label on the ring — "AI", "Idea 3". Long text does not survive a radial layout. */
  label: string;
  /** Shown in the centre while this item is under the cursor, where there is room for it. */
  detail: string;
  /** The colour this choice commits, and what the ring previews on hover. */
  hue: string;
  /** Rainbow choices (the agent's pick) have no single hue — they keep the full dispersion instead. */
  rainbow?: boolean;
}

interface RadialDialProps {
  items: DialItem[];
  /** Rendered at the centre of the ring — the fragment being given a colour. */
  center: ReactNode;
  /** Fallback centre caption when nothing is hovered. */
  hint: string;
  onPick: (id: string) => void;
  onDismiss: () => void;
}

const RADIUS = 40; // % of the dial box's half-extent

export function RadialDial({ items, center, hint, onPick, onDismiss }: RadialDialProps) {
  const [hovered, setHovered] = useState<DialItem | null>(null);

  return (
    // Fixed, not absolute: the ring is sized against the VIEWPORT. Scoped
    // to the stage's content box it overflowed the bottom and right edges
    // (two of eight choices were unreachable) and the scrim only dimmed
    // part of the page.
    //
    // `pointer-events-auto` because the dial mounts inside StageFrame's
    // pointer-transparent content box: a modal is the one surface that
    // SHOULD swallow everything under it, scrim included, and without this
    // the scrim inherited `none` and clicking off the ring did nothing.
    <div className="pointer-events-auto fixed inset-0 z-40">
      {/* Clicking off the ring backs out without choosing. A real button so
          the escape is reachable without a pointer. */}
      <button
        type="button"
        aria-label="Cancel this choice"
        className="dial-scrim absolute inset-0 h-full w-full cursor-default"
        onClick={onDismiss}
      />

      <div className="pointer-events-none absolute inset-0 grid place-items-center">
        <div className="relative aspect-square h-[min(82vh,82vw)]">
          <div className="absolute inset-0 grid place-items-center">
            <div className="pointer-events-auto relative grid h-[38%] w-[38%] place-items-center">{center}</div>
          </div>

          {/* The centre readout: what the cursor is currently lighting.
              Above the ring's centre, clear of the stage footer. */}
          <div className="pointer-events-none absolute inset-x-[24%] top-[68%] text-center">
            <p className="font-display text-base font-semibold tracking-tight text-mercury">{hovered?.label ?? ""}</p>
            <p className="mx-auto mt-1 max-w-xs text-xs leading-relaxed text-bone">{hovered?.detail ?? hint}</p>
          </div>

          {items.map((item, i) => {
            // Start at the top and go clockwise, so the ring reads in the
            // order the items were given rather than from an arbitrary edge.
            const angle = (i / items.length) * Math.PI * 2 - Math.PI / 2;
            const left = 50 + Math.cos(angle) * RADIUS;
            const top = 50 + Math.sin(angle) * RADIUS;
            const isHot = hovered?.id === item.id;

            return (
              // The wrapper owns the ring position and the centring offset;
              // the button owns its own transform for hover and press. They
              // cannot share one `transform`: .btn's hover rule replaces it
              // wholesale, which would fling each choice half its own width
              // off the ring the moment it was pointed at.
              <div
                key={item.id}
                className="pointer-events-none absolute"
                style={{ left: `${left}%`, top: `${top}%`, transform: "translate(-50%, -50%)" }}
              >
                <button
                  type="button"
                  onPointerEnter={() => setHovered(item)}
                  onPointerLeave={() => setHovered((h) => (h?.id === item.id ? null : h))}
                  onFocus={() => setHovered(item)}
                  onBlur={() => setHovered((h) => (h?.id === item.id ? null : h))}
                  onClick={() => onPick(item.id)}
                  className="btn pointer-events-auto whitespace-nowrap px-4 py-2 text-xs"
                  style={
                    {
                      background: isHot && item.rainbow !== true ? item.hue : "var(--ink)",
                      color: isHot && item.rainbow !== true ? "#ffffff" : "var(--mercury)",
                      borderColor: isHot ? "transparent" : undefined,
                      boxShadow: isHot ? `var(--shadow-3), 0 0 26px ${item.rainbow === true ? "rgba(150,120,255,.55)" : item.hue}` : undefined,
                    } as CSSProperties
                  }
                >
                  {item.label}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}