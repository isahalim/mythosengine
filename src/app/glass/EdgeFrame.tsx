/**
 * The persistent border of glass behind stages 2-6.
 *
 * Board 1 stage 2: "the same 3D interactive glass shards now in the
 * edges." It stays mounted across every stage after sign-in, so the
 * fragments never re-enter — the surface the operator signed into is
 * the surface they keep working on.
 *
 * These are fully interactive: they tilt toward the cursor and take the
 * hover highlight like every other fragment on the page (operator
 * direction, 2026-08-31 — "ALL glass shards should be 3d and have hover
 * highlight effect and tilt, including the shards on the edges"). They
 * lift less than a stage fragment does, because a border piece leaping
 * forward as the cursor crosses it on the way somewhere else is noise,
 * and they never take a colour: the border is the room, not the work.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { preloadAtlas, type SetKey } from "./geometry.ts";
import { edgeLayout } from "./layouts.ts";
import { Shard } from "./Shard.tsx";
import { useShardField } from "./useShardField.ts";

export function EdgeFrame({ setKey }: { setKey: SetKey }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const placements = useMemo(() => edgeLayout(setKey), [setKey]);

  useEffect(() => {
    let cancelled = false;
    void preloadAtlas(setKey).then(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [setKey]);

  useShardField(rootRef, placements, { ready, hoverLift: 34 });

  return (
    <div ref={rootRef} className="fixed inset-0 z-0 overflow-hidden" style={{ perspective: "1250px" }} aria-hidden="true">
      <div className="absolute inset-0" style={{ transformStyle: "preserve-3d" }}>
        {ready &&
          placements.map((p) => (
            <Shard
              key={p.key}
              pieceId={p.pieceId}
              setKey={p.setKey}
              className="shard--edge"
              style={{ left: `${p.x}%`, top: `${p.y}%`, width: `${p.w}%`, height: `${p.h}%`, zIndex: p.z }}
            />
          ))}
      </div>
    </div>
  );
}
