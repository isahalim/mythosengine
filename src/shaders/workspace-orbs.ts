/*
  The console workspace ground (plan v2 §7, operator direction 2026-08-31):
  "large soft rainbow gradient spheres drift slowly through the centre like a
  lava lamp, colours mixing where they overlap — the workspace where controls
  appear progressively".

  This is the *same* background the shattered-glass hero refracts, from the
  same GLSL and the same layout constants — see the note beside ORB_CENTRES.
  Sign-in disperses the pane and reveals this canvas mid-drift, so if the two
  disagreed on where the spheres are, the hero would visibly dissolve one
  page and reveal another.

  It is shader-driven rather than stacked blurred divs on purpose, and the
  reason is the one thing CSS cannot do here: two overlapping blurred
  gradients composite, they do not *mix*. The shader averages the spheres, so
  pink over teal resolves to the hue between them — which is the whole lava
  lamp metaphor. A stack of `filter: blur()` divs gives you pink in front of
  teal, and no third colour anywhere.
*/
import { Vector2, Vector3 } from "three";

import {
  GLASS_BACKGROUND_GLSL,
  GLASS_BACKGROUND_UNIFORMS_GLSL,
  ORB_CENTRES,
  ORB_RADII,
  ORB_SPEEDS,
  type GlassPalette,
} from "./glass-background.glsl";
import { mountFullscreenShader, prefersReducedMotion } from "./fullscreen";

const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;

  in vec2 vUv;
  out vec4 fragColour;

  uniform float uTime;

  ${GLASS_BACKGROUND_UNIFORMS_GLSL}
  ${GLASS_BACKGROUND_GLSL}

  void main() {
    fragColour = vec4(workspaceBackground(vUv, uTime), 1.0);
  }
`;

export interface WorkspaceOrbsHandle {
  destroy(): void;
}

/**
 * Mount the drifting spheres onto a full-viewport canvas.
 *
 * Returns `null` when WebGL2 is unavailable or the program fails to link, so
 * the caller keeps its CSS fallback rather than showing an empty canvas.
 */
export function mountWorkspaceOrbs(canvas: HTMLCanvasElement, palette: GlassPalette): WorkspaceOrbsHandle | null {
  const reducedMotion = prefersReducedMotion();

  const uniforms = {
    uTime: { value: 0 },
    uAspect: { value: 1 },
    uGround: { value: new Vector3(...palette.ground) },
    uOrbColours: { value: palette.orbs.map((c) => new Vector3(...c)) },
    uOrbCentres: { value: ORB_CENTRES.map(([x, y]) => new Vector2(x, y)) },
    uOrbRadii: { value: ORB_RADII },
    uOrbSpeeds: { value: ORB_SPEEDS },
  };

  /*
    Under reduced motion this renders exactly one frame and stops. The
    spheres are pure ambience — nothing the operator is waiting on depends on
    them moving — so the honest response to "less motion" is a still
    gradient, not a slower drift. `animate: false` also means the loop is
    never started, so it costs nothing at all after mount.
  */
  // Assigned after mount, read by onResize below. `onResize` fires once
  // *during* mount, before this is set — that first call needs no redraw,
  // because mount renders its own verification frame straight after.
  let redraw: (() => void) | null = null;

  const shader = mountFullscreenShader(canvas, {
    label: "workspace-orbs",
    fragmentShader: FRAGMENT_SHADER,
    uniforms,
    animate: !reducedMotion,
    onResize: (width, height) => {
      uniforms.uAspect.value = width / Math.max(height, 1);
      // A resize under reduced motion has no loop to pick up the new aspect,
      // so redraw here or the spheres stay stretched to the old viewport.
      if (reducedMotion) redraw?.();
    },
    onFrame: (elapsed) => {
      uniforms.uTime.value = elapsed;
    },
  });

  if (!shader) return null;

  redraw = () => shader.renderOnce();

  return { destroy: () => shader.destroy() };
}
