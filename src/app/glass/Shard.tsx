/**
 * One glass fragment.
 *
 * Layer stack, outside in — the source component's structure exactly
 * (@gughigug, 21st.dev), with the layers our stages need added inside the
 * same mask so they are clipped to the fracture silhouette like everything
 * else:
 *
 *   .shard          the 3D transform layer the spring loop writes to
 *   .shard-inlay    carries the alpha mask cut from the atlas sprite
 *     .shard-face   the glass itself (inverted + multiply — see shards.css)
 *     .shard-sheen  ambient room light
 *     .shard-tint   the rainbow / topic wash (stages 2-6)
 *     .shard-spec   cursor-tracked specular
 *     children      whatever this fragment is showing
 */
import type { CSSProperties, ReactNode } from "react";
import { atlasUrl, shardSpriteStyle, spriteStyle, type SetKey } from "./geometry.ts";

interface ShardProps {
  pieceId: string;
  setKey: SetKey;
  /** Position and size as a % of the parent field. */
  style: CSSProperties;
  /** Extra state classes — shard--lit, shard--rainbow, shard--muted, shard--gone. */
  className?: string;
  /** The topic wash and its halo, when this fragment has been given a colour. */
  wash?: string;
  halo?: string;
  onClick?: () => void;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
  label?: string;
  children?: ReactNode;
}

export function Shard({
  pieceId,
  setKey,
  style,
  className = "",
  wash,
  halo,
  onClick,
  onPointerEnter,
  onPointerLeave,
  label,
  children,
}: ShardProps) {
  const mask = shardSpriteStyle(setKey, pieceId);
  const sprite = spriteStyle(setKey, pieceId);
  const vars = {
    ...(wash === undefined ? {} : { "--shard-wash": wash }),
    ...(halo === undefined ? {} : { "--shard-halo": halo }),
  } as CSSProperties;

  // Interactive fragments are real buttons: the whole point of stages 2-4
  // is choosing them, and a div with a click handler is not reachable by
  // keyboard. Decorative ones stay divs so they are not announced at all.
  const interactive = onClick !== undefined;
  const Tag = interactive ? "button" : "div";

  return (
    <Tag
      data-shard
      type={interactive ? "button" : undefined}
      aria-label={label}
      className={`shard ${className}`}
      style={{ ...style, ...vars, ...(interactive ? { appearance: "none", border: "none", background: "none", padding: 0 } : {}) }}
      onClick={onClick}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <div className="shard-inlay" style={mask}>
        <div
          className="shard-layer shard-face"
          style={{ backgroundImage: `url(${atlasUrl(setKey)})`, backgroundSize: sprite.backgroundSize, backgroundPosition: sprite.backgroundPosition }}
        />
        <div className="shard-layer shard-sheen" />
        <div className="shard-layer shard-tint" />
        <div className="shard-layer shard-spec" />
        {children}
      </div>
    </Tag>
  );
}
