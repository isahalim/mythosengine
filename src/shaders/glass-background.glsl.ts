/*
  The workspace background, as GLSL.

  This is exported as a string rather than living inside one shader because
  two different things need the *same* background: the lava-lamp spheres that
  drift behind the console workspace, and the shattered-glass hero, which
  refracts them. Refraction is only honest if the glass bends the actual
  background — if the hero faked its own backdrop, the shards would reveal a
  different world than the one they disperse into.

  Colours are passed in as uniforms from tokens.css rather than hardcoded, so
  the palette stays in one file (CLAUDE.md: tokens.css is the only place raw
  hex is allowed).
*/
export const GLASS_BACKGROUND_GLSL = /* glsl */ `
  // Four drifting rainbow spheres over the ground colour. Lissajous paths so
  // the motion never visibly repeats.
  //
  // The spheres are accumulated as a *weighted average*, not added. Additive
  // blending is the obvious choice and it is wrong here: the ground is white,
  // so every channel is already at 1.0 and adding light does nothing at all.
  // Averaging means an overlap resolves to a genuine third hue -- pink over
  // teal gives the colour between them, which is the mixing the lava-lamp
  // metaphor is actually about -- while staying in gamut on a white page.
  vec3 workspaceBackground(vec2 uv, float t) {
    vec3 accum = vec3(0.0);
    float weight = 0.0;

    // Distances are measured in aspect-corrected space, otherwise a circle in
    // uv is an ellipse on screen and the "spheres" read as horizontal smears
    // on any viewport that is not square.
    vec2 p = vec2((uv.x - 0.5) * uAspect, uv.y - 0.5);

    for (int i = 0; i < 4; i++) {
      float fi = float(i);
      vec2 centre = uOrbCentres[i]
        + vec2(sin(t * uOrbSpeeds[i] + fi * 1.7), cos(t * uOrbSpeeds[i] * 0.83 + fi * 2.3)) * 0.17;
      vec2 c = vec2((centre.x - 0.5) * uAspect, centre.y - 0.5);

      float d = distance(p, c);
      // Smooth falloff, gently sharpened: soft enough to read as light rather
      // than as a shape with an edge, but not so soft it washes to nothing.
      float fall = 1.0 - smoothstep(0.0, uOrbRadii[i], d);
      fall = pow(fall, 1.4);

      accum += uOrbColours[i] * fall;
      weight += fall;
    }

    vec3 mixed = accum / max(weight, 1e-4);
    // Total coverage decides how far the ground is tinted, so the page stays
    // white where no sphere reaches and never washes out where several do.
    return mix(uGround, mixed, clamp(weight, 0.0, 1.0));
  }
`;

/*
  Shared uniform declarations for the background above. Kept beside it so a
  consumer cannot declare one without the other and silently get a black
  screen from an undefined uniform.
*/
export const GLASS_BACKGROUND_UNIFORMS_GLSL = /* glsl */ `
  uniform float uAspect;
  uniform vec3 uGround;
  uniform vec3 uOrbColours[4];
  uniform vec2 uOrbCentres[4];
  uniform float uOrbRadii[4];
  uniform float uOrbSpeeds[4];
`;

/** Colours the background needs, read from tokens.css by the caller. */
export interface GlassPalette {
  /** The workspace ground the glass disperses to reveal. */
  ground: [number, number, number];
  /** Four rainbow sphere tints, averaged over the ground. */
  orbs: [number, number, number][];
}

/*
  Sphere layout. They sit close enough to the centre that their falloffs
  genuinely overlap — the overlap is the point, since that is where two hues
  average into a third. Spread them to the corners and you get four separate
  coloured blobs and no lava lamp.

  Radii are large relative to the spacing for the same reason, and the drift
  speeds are deliberately unrelated (no common factor) so the arrangement
  never returns to the same configuration.

  These live here, beside the GLSL, for the same reason the GLSL is shared:
  the hero refracts the background it is about to disperse into. If the hero
  and the workspace used different layouts, sign-in would dissolve one
  arrangement of spheres and reveal a different one — and the illusion that
  the glass was ever in front of *this* page would be gone.
*/
export const ORB_RADII = [0.54, 0.5, 0.58, 0.52];
export const ORB_SPEEDS = [0.055, 0.043, 0.067, 0.038];
export const ORB_CENTRES: [number, number][] = [
  [0.38, 0.4],
  [0.63, 0.44],
  [0.52, 0.66],
  [0.45, 0.3],
];
