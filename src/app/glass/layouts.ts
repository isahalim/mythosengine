/**
 * Where fragments sit, per stage.
 *
 * Three arrangements, all cut from the same 16-piece atlas:
 *
 *   pane()   the original composition — board 1 stage 1's landing hero
 *   edge()   the same fragments pushed out to the borders — board 1
 *            stage 2: "the same 3D interactive glass shards now in the
 *            edges", so the middle is free for the stage to work in
 *
 * The free-floating arrangement stages 2-5 use is NOT here: those groups
 * accumulate fragments as a video is specified, so they are defined by
 * what a video is made of (videoGlass.ts) rather than by a fixed layout.
 */
import { DESKTOP, MOBILE, type Piece, type SetKey } from "./geometry.ts";
import type { Placement } from "./useShardField.ts";

function piecesFor(setKey: SetKey): Piece[] {
  return setKey === "mobile" ? MOBILE : DESKTOP;
}

/** The composition as the source component arranges it. */
export function paneLayout(setKey: SetKey): Placement[] {
  return piecesFor(setKey).map((p) => ({
    key: p.id,
    pieceId: p.id,
    setKey,
    x: p.x,
    y: p.y,
    w: p.w,
    h: p.h,
    cx: p.cx,
    cy: p.cy,
    ring: p.ring,
    z: 10 + (2 - p.ring),
  }));
}

/**
 * Ten fragments pinned to the borders. Hand-placed rather than derived:
 * the pieces have wildly different aspect ratios, and an algorithm that
 * pushed each one outward from its pane position piled the tall ones on
 * top of each other in the corners. These are chosen so each edge gets
 * fragments whose shape suits it — the two tall slivers on the left and
 * right, the wide flat ones along the top and bottom.
 *
 * All of them sit on ring 2 (the furthest depth), so they parallax gently
 * and never compete with whatever the stage is doing in the middle.
 */
const EDGE_DESKTOP: [string, number, number, number, number][] = [
  // [pieceId, x%, y%, w%, h%]
  ["desktop-01a", -4.5, -8, 13, 58],
  ["desktop-03c", -7, 46, 15, 46],
  ["desktop-02c", 6, -13, 16, 22],
  ["desktop-04b", 26, -16, 26, 23],
  ["desktop-05b", 56, -14, 27, 21],
  ["desktop-01b", 91, -6, 6, 44],
  ["desktop-07a", 93, 38, 11, 31],
  ["desktop-07b", 89, 76, 10, 24],
  ["desktop-06a", 30, 88, 26, 20],
  ["desktop-03a", 62, 84, 22, 41],
];

const EDGE_MOBILE: [string, number, number, number, number][] = [
  ["mobile-01b", -6, -7, 58, 19],
  ["mobile-05b", 66, -9, 33, 27],
  ["mobile-02a", -12, 22, 30, 28],
  ["mobile-06a", 82, 30, 25, 23],
  ["mobile-04c", 74, 58, 34, 13],
  ["mobile-02b", -18, 62, 40, 20],
  ["mobile-03b", -4, 88, 52, 19],
  ["mobile-07b", 58, 89, 40, 16],
];

export function edgeLayout(setKey: SetKey): Placement[] {
  const rows = setKey === "mobile" ? EDGE_MOBILE : EDGE_DESKTOP;
  return rows.map(([pieceId, x, y, w, h]) => ({
    key: `edge-${pieceId}`,
    pieceId,
    setKey,
    x,
    y,
    w,
    h,
    cx: x + w / 2,
    cy: y + h / 2,
    ring: 2,
    z: 1,
  }));
}
