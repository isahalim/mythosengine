/**
 * The cuts a card can be made of — one per video, so no two cards on
 * screen are the same broken pane (operator direction, 2026-09-01).
 *
 * Every layout is eight fragments drawn from the portrait cut, whose
 * pieces already tessellate a 9:16 pane — which is exactly the aspect a
 * Short is, so the card is the video's own shape rather than an arbitrary
 * rectangle drawn around it.
 *
 * Only the *selection* varies, never a fragment's position, size or
 * rotation. That is not timidity, it is the only way the card survives:
 * each piece's x/y/w/h is where it landed in one real photographed break,
 * and the sprite in the atlas is that exact polygon. Move one, scale one,
 * or spin one and it stops meeting its neighbours — the silhouette that
 * reads as a shattered card becomes a pile of unrelated glass. Choosing
 * different fragments changes every size, shape and orientation on the
 * card while leaving the break itself intact.
 *
 * The six were picked by measuring rather than by eye: every one of the
 * 12,870 possible eight-fragment sets was rasterised from the atlas's own
 * alpha, kept only if it covers 37-48% of the pane with no vertical third
 * under 24% and no side under 26% (an empty band is what makes a card stop
 * reading as a card), and then chosen greedily for lowest pixel IoU
 * against the ones already picked. Layout 0 is the original hand-picked
 * cut, kept as the anchor; the most similar pair still overlaps only 55%,
 * and the closest to layout 0 overlaps 38%.
 */
export const FORGE_LAYOUTS: readonly (readonly string[])[] = [
  ["mobile-02a", "mobile-01b", "mobile-05b", "mobile-04a", "mobile-03b", "mobile-06a", "mobile-07b", "mobile-04c"],
  ["mobile-01a", "mobile-01b", "mobile-02b", "mobile-03a", "mobile-03b", "mobile-04b", "mobile-04c", "mobile-06b"],
  ["mobile-01a", "mobile-02a", "mobile-02b", "mobile-03b", "mobile-04b", "mobile-06a", "mobile-07a", "mobile-07b"],
  ["mobile-01a", "mobile-01b", "mobile-02b", "mobile-03a", "mobile-04a", "mobile-04c", "mobile-06a", "mobile-07b"],
  ["mobile-01a", "mobile-01b", "mobile-03a", "mobile-03b", "mobile-04a", "mobile-04b", "mobile-07a", "mobile-07b"],
  ["mobile-01a", "mobile-02a", "mobile-02b", "mobile-03a", "mobile-03b", "mobile-04a", "mobile-04c", "mobile-06b"],
];


/**
 * The cut for a given card.
 *
 * Wraps, so any card index is valid and the caller never has to know how
 * many layouts there are — and tolerates a negative or fractional index
 * rather than handing back `undefined` and failing inside the render.
 */
export function forgeLayout(variant: number): readonly string[] {
  if (!Number.isFinite(variant)) return FORGE_LAYOUTS[0];
  return FORGE_LAYOUTS[Math.abs(Math.trunc(variant)) % FORGE_LAYOUTS.length];
}
