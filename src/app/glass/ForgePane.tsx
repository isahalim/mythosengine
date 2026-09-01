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
 * The fracture is NOT an estimate. src/server/console/runs.ts is explicit
 * that the waiting screen "does not interpolate a percentage, estimate a
 * finish time, or report a stage the pipeline has not actually recorded",
 * and this obeys that: `healed` counts observed row facts (a script row
 * exists, a render row exists, that render says rendered, an export row
 * exists) and nothing else. A pane at half fracture means exactly two of
 * those four things are true, not "about halfway".
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { CRACKS, MOBILE, preloadAtlas } from "./geometry.ts";
import { Shard } from "./Shard.tsx";
import { useShardField, type Placement } from "./useShardField.ts";
import { useAtlasReady } from "../useAtlasReady.ts";
import type { MontageClip } from "../types.ts";

/**
 * The fragments that tile the card. Taken from the portrait cut, whose
 * pieces already tessellate a 9:16 pane — which is exactly the aspect a
 * Short is, so the card is the video's own shape rather than an arbitrary
 * rectangle drawn around it.
 */
const FORGE_PIECES = ["mobile-02a", "mobile-01b", "mobile-05b", "mobile-04a", "mobile-03b", "mobile-06a", "mobile-07b", "mobile-04c"];
/** How often each fragment swaps the keyword it is dreaming about. */
const CYCLE_MS = 3_600;

interface ForgePaneProps {
  /** 0 = whole, 1 = fully fractured. Derived from observed milestones by the caller. */
  fracture: number;
  glow: string;
  clips: MontageClip[];
  /** Pulse the cracks while the pipeline is actually working on this one. */
  working: boolean;
}

export function ForgePane({ fracture, glow, clips, working }: ForgePaneProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const ready = useAtlasReady("mobile", preloadAtlas);
  const [tick, setTick] = useState(0);

  const placements = useMemo<Placement[]>(
    () =>
      FORGE_PIECES.map((id, i) => {
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
    [],
  );

  // Board 3: "each shard piece reflects different aspect of video and
  // cycles." One timer for the pane; each fragment reads a different
  // offset into the clip list, so they are never all dreaming the same
  // thing at the same moment.
  useEffect(() => {
    if (clips.length === 0) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = window.setInterval(() => setTick((t) => t + 1), CYCLE_MS);
    return () => window.clearInterval(id);
  }, [clips.length]);

  useShardField(rootRef, placements, { ready, hoverLift: 46 });

  const cracks = CRACKS.mobile;

  return (
    <div ref={rootRef} className="forge-pane" style={{ "--forge-glow": glow, "--forge-fracture": fracture } as CSSProperties}>
      <div className="forge-shards">
        {ready &&
          placements.map((p, i) => {
            const clip = clips.length === 0 ? null : clips[(i + tick) % clips.length];
            return (
              <Shard
                key={p.key}
                pieceId={p.pieceId}
                setKey={p.setKey}
                style={{ left: `${p.x}%`, top: `${p.y}%`, width: `${p.w}%`, height: `${p.h}%`, zIndex: p.z }}
              >
                {clip !== null && (
                  // The dream. A still rather than a decoder per fragment:
                  // seven playing videos per card, times up to six cards,
                  // is not a page — and a slow cross-fade between keyword
                  // stills is what actually reads as dreaming.
                  <img
                    key={clip.id}
                    src={clip.thumbnailUrl}
                    alt=""
                    className="forge-dream forge-dream--on"
                    loading="lazy"
                    decoding="async"
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
