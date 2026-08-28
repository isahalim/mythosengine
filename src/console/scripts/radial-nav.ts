// Position/rotation math ported from 21st.dev's Radial Orbital Timeline
// (see RadialNav.astro's header comment) — calculateNodePosition and the
// auto-rotate interval are the actual reused mechanic. Rewritten as plain
// DOM/interval code, no React state.
//
// Expand/collapse behavior (docs/DECISIONS.md, operator's explicit spec):
// landing on /console shows the ring full-viewport; clicking a section node
// shrinks it back to the header position, then navigates; clicking the
// center (the Liquid Metal shader) expands it again in place; clicking
// empty backdrop space collapses without navigating.
import { mountLiquidMetal } from "../../shaders/liquid-metal.ts";

const ROTATE_STEP_DEG = 0.15;
const ROTATE_INTERVAL_MS = 50;
// Must match global.css: .radial-nav--collapsed .radial-nav-ring's 84px,
// and .radial-nav--expanded .radial-nav-ring's min(60vw, 60vh, 640px). CSS
// can't be read mid-transition without racing the animation, so these are
// kept as plain constants instead of measured from the DOM.
const COLLAPSED_RADIUS_PX = 42;
const COLLAPSE_TRANSITION_MS = 350;

function expandedRadiusPx(): number {
  return Math.min(window.innerWidth * 0.6, window.innerHeight * 0.6, 640) / 2;
}

function computePosition(index: number, total: number, rotationDeg: number, radius: number): { x: number; y: number; opacity: number } {
  const angleDeg = ((index / total) * 360 + rotationDeg) % 360;
  const angleRad = (angleDeg * Math.PI) / 180;
  const x = radius * Math.cos(angleRad);
  const y = radius * Math.sin(angleRad);
  // Nodes toward the top of the ring (screen -y) read clearer than ones
  // swinging behind/below it — same "opacity by angle" falloff idea the
  // source component uses for a z-depth illusion, applied here purely for
  // legibility instead.
  const opacity = Math.max(0.55, Math.min(1, 0.55 + 0.45 * ((1 - Math.sin(angleRad)) / 2)));
  return { x, y, opacity };
}

export function initRadialNav(): void {
  const navEl = document.getElementById("radial-nav");
  if (!navEl) return;
  const nav: HTMLElement = navEl;
  const backdrop = document.getElementById("radial-nav-backdrop");
  const centerButton = document.getElementById("radial-nav-center");
  const nodes = Array.from(nav.querySelectorAll<HTMLAnchorElement>("[data-radial-node]"));
  if (nodes.length === 0) return;

  const prefersReduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  let rotation = 0;
  let paused = false;
  let expanded = nav.dataset.expanded === "true";

  function render(): void {
    const radius = expanded ? expandedRadiusPx() : COLLAPSED_RADIUS_PX;
    nodes.forEach((node, index) => {
      const { x, y, opacity } = computePosition(index, nodes.length, rotation, radius);
      node.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px)`;
      node.style.opacity = String(opacity);
    });
  }

  function setExpanded(next: boolean): void {
    if (expanded === next) return;
    expanded = next;
    nav.dataset.expanded = String(next);
    nav.classList.toggle("radial-nav--expanded", next);
    nav.classList.toggle("radial-nav--collapsed", !next);
    backdrop?.classList.toggle("opacity-100", next);
    backdrop?.classList.toggle("opacity-0", !next);
    backdrop?.classList.toggle("pointer-events-none", !next);
    render();
  }

  render();
  window.addEventListener("resize", render);

  nav.addEventListener("mouseenter", () => {
    paused = true;
  });
  nav.addEventListener("mouseleave", () => {
    paused = false;
  });

  if (!prefersReduced) {
    const interval = window.setInterval(() => {
      if (!paused) {
        rotation = (rotation + ROTATE_STEP_DEG) % 360;
        render();
      }
    }, ROTATE_INTERVAL_MS);
    window.addEventListener("beforeunload", () => window.clearInterval(interval));
  }

  // Center click: collapsed -> expand in place, no navigation. Already
  // expanded -> no-op (nothing in the spec says a second center click
  // should do anything, so it doesn't).
  centerButton?.addEventListener("click", () => setExpanded(true));

  // Backdrop click (empty space, expanded only): collapse without
  // navigating — the expected escape hatch for a full-viewport menu.
  backdrop?.addEventListener("click", () => setExpanded(false));

  // Node click while expanded: animate the collapse, then navigate — "the
  // nav bar shrinks and goes to the top" the operator described, not an
  // instant jump cut. While already collapsed, this is a real <a href>
  // doing a real navigation — no JS needed for that path.
  for (const node of nodes) {
    node.addEventListener("click", (event) => {
      if (!expanded) return;
      event.preventDefault();
      const href = node.getAttribute("href");
      setExpanded(false);
      window.setTimeout(() => {
        if (href) window.location.href = href;
      }, COLLAPSE_TRANSITION_MS);
    });
  }

  // The operator asked for the same Liquid Metal shader (src/shaders/liquid-metal.ts)
  // at the center of this nav, not just the orbiting nodes — tinted to the
  // console's own oxide/sodium palette instead of the hero's mercury/ink
  // tones. The gradient div underneath (RadialNav.astro) stays as the
  // fallback if WebGL2 is unavailable or prefers-reduced-motion is set.
  if (centerButton && !prefersReduced) {
    void mountLiquidMetal(centerButton, { colorBack: "#2f6b57", colorTint: "#e8944a", scale: 1.4, repetition: 3 }).catch(() => {});
  }
}
