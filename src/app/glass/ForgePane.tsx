/**
 * One video under construction — board 3.
 *
 * "the agent is working on the video and 'fixing' the reality/fabric of
 * the video with glow effect coming out of cracks, and the individual
 * shards reflect the 'internal process' by showing keyword associated
 * footage like dreams (each shard piece reflects different aspect of video
 * and cycles), until progressively, final video is done rendering and
 * downloadable with no cracks."
 *
 * Operator direction (2026-08-31): the card shape is made PURELY out of
 * shards — there is no panel behind them and no rounded rectangle around
 * them. The fragments themselves tile a 9:16 card, the gaps between them
 * are the cracks, and the whole thing free-floats around the centre until
 * the video is made and the fracture solidifies.
 *
 * Operator direction (2026-09-01): the fragments are ordinary glass until
 * the cursor is on one. Eight stills cross-fading at once read as a collage
 * printed on the card rather than as glass with something behind it, and it
 * made the fracture — the thing this pane exists to show — the least
 * legible layer on screen. Each fragment now holds ONE still for the life
 * of the pane and reveals it only while hovered, so the reveal is an act
 * the operator performs rather than an animation that runs at them.
 *
 * That applies everywhere the pane appears, stage 6 included (operator
 * direction, 2026-09-01). Stage 6 briefly had an always-on variant on the
 * argument that the still is what tells one finished video from another at
 * a glance — but a grid of cards with every fragment lit is a wall of
 * thumbnails in the shape of glass, and the thing it identified them by was
 * the thing it destroyed. The title, status and hook under each card do
 * that job in text, which is what they are for.
 *
 * The fracture is NOT an estimate. src/server/console/runs.ts is explicit
 * that the waiting screen "does not interpolate a percentage, estimate a
 * finish time, or report a stage the pipeline has not actually recorded",
 * and this obeys that: `healed` counts observed row facts (a script row
 * exists, a render row exists, that render says rendered, an export row
 * exists) and nothing else. A pane at half fracture means exactly two of
 * those four things are true, not "about halfway".
 */
import { useMemo, useRef, useState, type CSSProperties } from "react";
import { forgeLayout } from "./forge-layouts.ts";
import { CRACKS, MOBILE, preloadAtlas } from "./geometry.ts";
import { Shard } from "./Shard.tsx";
import { useShardField, type Placement } from "./useShardField.ts";
import { useAtlasReady } from "../useAtlasReady.ts";
import type { MontageClip } from "../types.ts";

interface ForgePaneProps {
  /** 0 = whole, 1 = fully fractured. Derived from observed milestones by the caller. */
  fracture: number;
  glow: string;
  clips: MontageClip[];
  /** Pulse the cracks while the pipeline is actually working on this one. */
  working: boolean;
  /**
   * Which cut this card is broken along. Pass the card's own index so a row
   * of them is a row of different panes; it wraps, so any number is valid.
   * It must be STABLE for a given card — a card that re-cuts itself on a
   * re-render is a card that shatters again while the operator is reading
   * it, and any reveals they had uncovered would go with it.
   */
  variant?: number;
}

export function ForgePane({ fracture, glow, clips, working, variant = 0 }: ForgePaneProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const ready = useAtlasReady("mobile", preloadAtlas);

  /**
   * Fragments whose reveal has fully arrived, and therefore stays
   * (operator direction, 2026-09-01). Keyed by placement, so it is per
   * fragment and never per card: uncovering one piece uncovers exactly
   * that piece, permanently, and its neighbours are still glass.
   *
   * A *completed* fade is the condition, which is why this is driven by
   * the transition's own end rather than by a timer or by pointerleave.
   * The operator who passes over a fragment and moves on has not chosen to
   * uncover it and it fades back; the one who rests on it until the image
   * is fully up has, and it keeps.
   */
  const [kept, setKept] = useState<ReadonlySet<string>>(() => new Set());

  const pieces = forgeLayout(variant);

  const placements = useMemo<Placement[]>(
    () =>
      pieces.map((id, i) => {
        const piece = MOBILE.find((p) => p.id === id);
        if (piece === undefined) throw new Error(`unknown mobile piece: ${id}`);
        return {
          key: `forge-${id}`,
          pieceId: id,
          setKey: "mobile" as const,
          x: piece.x,
          y: piece.y,
          w: piece.w,
          h: piece.h,
          cx: piece.cx,
          cy: piece.cy,
          ring: piece.ring,
          z: 10 + i,
        };
      }),
    [pieces],
  );

  useShardField(rootRef, placements, { ready, hoverLift: 46 });

  const cracks = CRACKS.mobile;

  return (
    <div ref={rootRef} className="forge-pane" style={{ "--forge-glow": glow, "--forge-fracture": fracture } as CSSProperties}>
      <div className="forge-shards">
        {ready &&
          placements.map((p, i) => {
            // Stable for the life of the pane: fragment i always holds the
            // same still, so hovering the same piece twice shows the same
            // thing and the operator can go back to one they half-saw.
            const clip = clips.length === 0 ? null : clips[i % clips.length];
            return (
              <Shard
                key={p.key}
                pieceId={p.pieceId}
                setKey={p.setKey}
                style={{ left: `${p.x}%`, top: `${p.y}%`, width: `${p.w}%`, height: `${p.h}%`, zIndex: p.z }}
              >
                {clip !== null && (
                  // The dream, revealed under the cursor. A still rather than
                  // a decoder per fragment: eight playing videos per card,
                  // times up to six cards, is not a page.
                  //
                  // Mounted always and revealed by CSS (`.shard--hot` — the
                  // class useShardField already writes on pointerenter)
                  // rather than mounted on hover: a still that starts loading
                  // when the cursor arrives shows nothing for the first
                  // moments of the reveal, which is exactly the moment the
                  // operator is looking at it — and the reveal is now over a
                  // second long, so a late image would surface visibly
                  // mid-fade. `loading="lazy"` still keeps a pane that is
                  // scrolled away from costing nothing.
                  <img
                    key={clip.id}
                    src={clip.thumbnailUrl}
                    alt=""
                    className={`forge-dream ${kept.has(p.key) ? "forge-dream--kept" : ""}`}
                    loading="lazy"
                    decoding="async"
                    // The latch. `transitionend` fires for the fade OUT as
                    // well, and at that moment the fragment is at zero and
                    // nothing should be kept — so the test is not "a
                    // transition finished" but "a transition finished while
                    // this fragment was still under the cursor", which only
                    // a completed reveal satisfies. An interrupted one ends
                    // its life in the fade-out's own transitionend, cold.
                    onTransitionEnd={(e) => {
                      if (e.propertyName !== "opacity") return;
                      const shard = e.currentTarget.closest("[data-shard]");
                      if (shard === null || !shard.classList.contains("shard--hot")) return;
                      setKept((prev) => (prev.has(p.key) ? prev : new Set(prev).add(p.key)));
                    }}
                    // A still that will not load is hidden rather than left
                    // as the browser's broken-image glyph inside the glass.
                    // This is presentation, not a swallowed error: the
                    // fragment falls back to plain glass, which is exactly
                    // what it looks like when there is no clip for it, and
                    // the stage's caption already tells the operator what
                    // the shards are showing and where it comes from.
                    onError={(e) => {
                      e.currentTarget.hidden = true;
                    }}
                  />
                )}
              </Shard>
            );
          })}
      </div>

      {/* The fracture itself, glowing from within — and healing as the
          milestones land. At fracture 0 the opacity is 0: no cracks. */}
      <svg
        className={`forge-crack ${working ? "forge-crack--working" : ""}`}
        viewBox={`0 0 ${cracks.w} ${cracks.h}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <g style={{ strokeWidth: 2.4, opacity: 0.5 }}>
          {cracks.main.map((d) => (
            <path key={d} d={d} />
          ))}
        </g>
        <g style={{ strokeWidth: 1 }}>
          {cracks.main.map((d) => (
            <path key={`l-${d}`} d={d} />
          ))}
        </g>
      </svg>
    </div>
  );
}
