/**
 * The landing hero — board 1 stage 1.
 *
 * The composition from "Broken by Design" (@gughigug, 21st.dev), with the
 * word masked into every fragment so the slogan is physically broken
 * across the pane: each shard carries its own slice of the same text node,
 * scaled back up to full-pane size and offset by that shard's position, so
 * the letters line up across the fracture and then tilt with it.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { CRACKS, jitter, preloadAtlas, type SetKey } from "./geometry.ts";
import { paneLayout } from "./layouts.ts";
import { Shard } from "./Shard.tsx";
import { useShardField } from "./useShardField.ts";

interface ShardPaneProps {
  title: string;
  setKey: SetKey;
  className?: string;
}

export function ShardPane({ title, setKey, className = "" }: ShardPaneProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const portrait = setKey === "mobile";

  const placements = useMemo(() => paneLayout(setKey), [setKey]);
  const jitters = useMemo(() => placements.map((_, i) => jitter(i + 1)), [placements]);
  const cracks = CRACKS[setKey];

  // Nothing renders until the sprite has actually decoded: one request
  // lands close to atomically, so the pane appears glass-ready in one beat
  // instead of trickling in fragment by fragment.
  useEffect(() => {
    let cancelled = false;
    setReady(false);
    void preloadAtlas(setKey).then(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [setKey]);

  useShardField(rootRef, placements, { ready });

  const titleNode = portrait ? (
    <span className="pane-word pane-stack">
      {title.split(" ").map((w) => (
        <em key={w}>{w}</em>
      ))}
    </span>
  ) : (
    <span className="pane-word">{title}</span>
  );

  return (
    <div ref={rootRef} className={`pane ${portrait ? "pane--portrait" : ""} ${className}`} aria-label={title} role="img">
      <div className="pane-stage">
        {ready && (
          <>
            {/* The word where it is exposed between the fragments. */}
            <div className="pane-title pane-title--under" aria-hidden="true">
              {titleNode}
            </div>

            {/* The fracture network continuing through the gaps. */}
            <svg className="pane-cracks" viewBox={`0 0 ${cracks.w} ${cracks.h}`} preserveAspectRatio="none" aria-hidden="true">
              <g className="pane-cracks-glow">
                {cracks.main.map((d) => (
                  <path key={d} d={d} />
                ))}
              </g>
              <g className="pane-cracks-line">
                {cracks.main.map((d) => (
                  <path key={d} d={d} />
                ))}
              </g>
              <g className="pane-cracks-fine">
                {cracks.fine.map((d) => (
                  <path key={d} d={d} />
                ))}
              </g>
            </svg>

            <div className="pane-shards" aria-hidden="true">
              {placements.map((p, i) => {
                const j = jitters[i];
                return (
                  <Shard
                    key={p.key}
                    pieceId={p.pieceId}
                    setKey={p.setKey}
                    style={{ left: `${p.x}%`, top: `${p.y}%`, width: `${p.w}%`, height: `${p.h}%`, zIndex: p.z }}
                  >
                    {/* This fragment's slice of the word: the full-pane
                        text box, scaled up by 1/size and shifted back by
                        the fragment's own offset, so the glyphs land in
                        exactly the same place they do in the layer above. */}
                    <div
                      className="pane-slice"
                      style={
                        {
                          width: `${10000 / p.w}%`,
                          height: `${10000 / p.h}%`,
                          left: `${-(p.x / p.w) * 100}%`,
                          top: `${-(p.y / p.h) * 100}%`,
                          "--jt": `translate(${j.tx.toFixed(1)}px, ${j.ty.toFixed(1)}px) rotate(${j.rot.toFixed(2)}deg)`,
                        } as CSSProperties
                      }
                    >
                      {titleNode}
                    </div>
                  </Shard>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
