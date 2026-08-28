// Position/rotation math ported from 21st.dev's Radial Orbital Timeline
// (see RadialNav.astro's header comment) — calculateNodePosition and the
// auto-rotate interval are the actual reused mechanic, scaled from a
// radius of 200px in a full-screen hero down to fit a persistent nav
// widget. Rewritten as plain DOM/interval code, no React state.
import { mountLiquidMetal } from "../../shaders/liquid-metal.ts";

const ROTATE_STEP_DEG = 0.15;
const ROTATE_INTERVAL_MS = 50;
const RADIUS_PX = 36;

function computePosition(index: number, total: number, rotationDeg: number): { x: number; y: number; opacity: number } {
  const angleDeg = ((index / total) * 360 + rotationDeg) % 360;
  const angleRad = (angleDeg * Math.PI) / 180;
  const x = RADIUS_PX * Math.cos(angleRad);
  const y = RADIUS_PX * Math.sin(angleRad);
  // Nodes toward the top of the ring (screen -y) read clearer against the
  // header than ones swinging behind/below it — same "opacity by angle"
  // falloff idea the source component uses for a z-depth illusion, applied
  // here purely for legibility instead.
  const opacity = Math.max(0.55, Math.min(1, 0.55 + 0.45 * ((1 - Math.sin(angleRad)) / 2)));
  return { x, y, opacity };
}

export function initRadialNav(): void {
  const nav = document.getElementById("radial-nav");
  if (!nav) return;
  const nodes = Array.from(nav.querySelectorAll<HTMLAnchorElement>("[data-radial-node]"));
  if (nodes.length === 0) return;

  const prefersReduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  let rotation = 0;
  let paused = false;

  function render(): void {
    nodes.forEach((node, index) => {
      const { x, y, opacity } = computePosition(index, nodes.length, rotation);
      node.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px)`;
      node.style.opacity = String(opacity);
    });
  }

  render();
  if (prefersReduced) return;

  const interval = window.setInterval(() => {
    if (paused) return;
    rotation = (rotation + ROTATE_STEP_DEG) % 360;
    render();
  }, ROTATE_INTERVAL_MS);

  nav.addEventListener("mouseenter", () => {
    paused = true;
  });
  nav.addEventListener("mouseleave", () => {
    paused = false;
  });

  window.addEventListener("beforeunload", () => window.clearInterval(interval));

  // The operator asked for the same Liquid Metal shader (src/shaders/liquid-metal.ts)
  // at the center of this nav, not just the orbiting nodes — tinted to the
  // console's own oxide/sodium palette instead of the hero's mercury/ink
  // tones, small scale so the pattern reads as a shimmer rather than tiling
  // visibly at 24px. The gradient div underneath (RadialNav.astro) stays as
  // the fallback if WebGL2 is unavailable or prefers-reduced-motion is set.
  const center = document.getElementById("radial-nav-center");
  if (center && !prefersReduced) {
    void mountLiquidMetal(center, { colorBack: "#2f6b57", colorTint: "#e8944a", scale: 0.35, repetition: 3 }).catch(() => {});
  }
}
