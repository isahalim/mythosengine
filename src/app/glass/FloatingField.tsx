/**
 * The free-floating shard field — the surface every stage after the
 * landing works on.
 *
 * Operator direction (2026-08-31): no cards. The shards the operator lit
 * in stage 2 keep floating around the centre of the page for topics,
 * ideas and the forge; the pieces that fuse onto them join the same
 * drifting group. So a video is not a card containing glass — it IS its
 * glass, and it is the same glass from the moment it is lit until the
 * video is downloadable.
 *
 * One `useShardField` per group rather than one for the whole field: the
 * spring loop resolves a fragment's rest pose from its index within the
 * placement array it was given, so groups have to own their own arrays
 * for a fragment to keep its pose as siblings appear beside it.
 */
import { useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import { preloadAtlas, type SetKey } from "./geometry.ts";
import { Shard } from "./Shard.tsx";
import { useShardField, type Placement } from "./useShardField.ts";
import { useAtlasReady } from "../useAtlasReady.ts";

/** One fragment inside a group, with the state the stage wants it drawn in. */
export interface GroupShard {
  key: string;
  pieceId: string;
  setKey: SetKey;
  x: number;
  y: number;
  w: number;
  h: number;
  ring: number;
  z: number;
  lit?: boolean;
  rainbow?: boolean;
  wash?: string;
  halo?: string;
  children?: ReactNode;
}

interface FloatingGroupProps {
  shards: GroupShard[];
  /** Position and size of the group's box, as a % of the field. */
  box: { x: number; y: number; w: number; h: number };
  /** Drift character — stable per group so a video's glass always moves the same way. */
  seed: number;
  onClick?: () => void;
  label?: string;
  caption?: ReactNode;
  dimmed?: boolean;
}

/** Deterministic [0,1) so a group's drift never changes between renders. */
function rand(seed: number, n: number): number {
  const v = Math.sin(seed * 63.7 + n * 149.3) * 43758.5453;
  return v - Math.floor(v);
}

export function FloatingGroup({ shards, box, seed, onClick, label, caption, dimmed = false }: FloatingGroupProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const ready = useAtlasReady("desktop", preloadAtlas);

  const placements = useMemo<Placement[]>(
    () =>
      shards.map((s) => ({
        key: s.key,
        pieceId: s.pieceId,
        setKey: s.setKey,
        x: s.x,
        y: s.y,
        w: s.w,
        h: s.h,
        cx: s.x + s.w / 2,
        cy: s.y + s.h / 2,
        ring: s.ring,
        z: s.z,
      })),
    [shards],
  );

  useShardField(rootRef, placements, { ready, hoverLift: 70 });

  const drift = {
    "--float-dur": `${(10 + rand(seed, 1) * 9).toFixed(1)}s`,
    "--float-delay": `${(-rand(seed, 2) * 8).toFixed(1)}s`,
    "--float-x": `${(9 + rand(seed, 3) * 16).toFixed(0)}px`,
    "--float-y": `${(11 + rand(seed, 4) * 18).toFixed(0)}px`,
    "--float-rot": `${(0.8 + rand(seed, 5) * 2).toFixed(2)}deg`,
  } as CSSProperties;

  return (
    <div
      className="float-group"
      style={{ ...drift, left: `${box.x}%`, top: `${box.y}%`, width: `${box.w}%`, height: `${box.h}%` }}
    >
      <div ref={rootRef} className="relative h-full w-full" style={{ perspective: "900px" }}>
        <div className="absolute inset-0" style={{ transformStyle: "preserve-3d", opacity: dimmed ? 0.45 : 1 }}>
          {ready &&
            shards.map((s) => (
              <Shard
                key={s.key}
                pieceId={s.pieceId}
                setKey={s.setKey}
                className={`${s.lit === true ? "shard--lit" : ""} ${s.rainbow === true ? "shard--rainbow" : ""}`}
                wash={s.wash}
                halo={s.halo}
                style={{ left: `${s.x}%`, top: `${s.y}%`, width: `${s.w}%`, height: `${s.h}%`, zIndex: s.z }}
              >
                {s.children}
              </Shard>
            ))}
        </div>

        {/* One transparent hit target over the whole group. Putting the
            click on each fragment instead would mean the group's meaning
            ("this video") was split across pieces that can move apart. */}
        {onClick !== undefined && (
          <button type="button" aria-label={label} onClick={onClick} className="absolute inset-0 z-30 cursor-pointer bg-transparent" />
        )}
      </div>

      {caption !== undefined && <div className="pointer-events-none absolute inset-x-0 top-full pt-1 text-center">{caption}</div>}
    </div>
  );
}

/** The field itself: a positioned box the groups float inside. */
export function FloatingField({ children }: { children: ReactNode }) {
  return <div className="relative h-full w-full">{children}</div>;
}

/**
 * Where N groups sit around the centre. A loose ring rather than a grid —
 * a grid of broken glass reads as a table — biased wider than tall,
 * because the viewport is.
 */
export function ringPositions(count: number): { x: number; y: number; w: number; h: number }[] {
  if (count === 1) return [{ x: 30, y: 22, w: 40, h: 56 }];

  const size = count <= 2 ? 34 : count <= 4 ? 29 : 25;
  const rx = count <= 2 ? 22 : 30;
  const ry = count <= 2 ? 0 : 20;

  return Array.from({ length: count }, (_, i) => {
    const angle = (i / count) * Math.PI * 2 - Math.PI / 2;
    return {
      x: 50 + Math.cos(angle) * rx - size / 2,
      y: 48 + Math.sin(angle) * ry - (size * 1.2) / 2,
      w: size,
      h: size * 1.2,
    };
  });
}
