// Public-homepage hero (docs/DECISIONS.md, 2026-08-28: reverses Phase 7's
// "no public hero" call — this is the console's opposite number, its own
// bundle, its own budget). Tier 2 over src/components/HeroOrb.astro's
// tier-1 static SVG poster: WebGL absent, `prefers-reduced-motion`, or a
// lost context all just mean the poster stays visible and this module
// never mounts anything over it.
//
// As of 2026-08-28 (night, later, docs/DECISIONS.md) this mounts the real
// "Liquid Metal" shader from @paper-design/shaders (src/shaders/liquid-metal.ts)
// instead of the original hand-rolled raymarched-sphere GLSL — the operator
// asked for the actual 21st.dev "Liquid Metal Hero" asset installed and
// used directly, not just approximated.
import { mountLiquidMetal } from "../shaders/liquid-metal.ts";

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Mounts the shader into `container`, over the static SVG poster (never
 * removes the poster — it stays as the paint underneath, and as the only
 * visible thing if this fails). Every failure mode is a silent no-op, not
 * a thrown error that could break the rest of the page.
 */
export function initHeroOrb(container: HTMLElement): void {
  if (prefersReducedMotion()) return;

  void mountLiquidMetal(container, {
    colorBack: "#10131a", // --ink
    colorTint: "#c9d2da", // --mercury
    scale: 1.4,
  }).catch(() => {
    // no WebGL2, or the tiny placeholder texture failed to load — the SVG
    // poster underneath is the whole experience in that case.
  });
}
