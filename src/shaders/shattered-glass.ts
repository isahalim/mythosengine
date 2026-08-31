/*
  The console's shattered-glass hero (CONSOLE_SPEC / plan v2 §7, operator
  direction 2026-08-31): a broken glass pane over the white workspace, which
  disperses to the edges on sign-in.

  Three.js, on explicit operator instruction (2026-08-31) — CLAUDE.md
  otherwise forbids adding a dependency. It is here for one reason: real
  refraction and real caustics. Both are computed, not painted:

  - **Refraction** bends the view ray through each shard's own surface normal
    and samples the background at the bent coordinate. The shards therefore
    show a genuinely displaced view of the same spheres the page disperses
    into, not a blurred copy pasted behind them.
  - **Caustics** fall out of that for free, and are the reason this is worth
    a dependency at all. Where a refractive surface compresses neighbouring
    rays into a smaller area, light concentrates — that concentration is the
    Jacobian determinant of the refraction mapping, which screen-space
    derivatives give us directly. Bright where rays converge, dim where they
    spread. No caustic texture, no fake bloom.

  Renders on a single full-screen triangle with a RawShaderMaterial, so
  three's shader-chunk injection never runs and the whole cost is the
  renderer plus this one program.
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

  uniform vec2 uResolution;
  uniform float uTime;
  uniform float uDisperse;   // 0 = intact pane, 1 = fully dispersed
  uniform vec2 uImpact;      // where the pane broke, in uv
  uniform float uMotion;     // 0 when the viewer prefers reduced motion

  ${GLASS_BACKGROUND_UNIFORMS_GLSL}
  ${GLASS_BACKGROUND_GLSL}

  vec2 hash2(vec2 p) {
    p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
    return fract(sin(p) * 43758.5453);
  }

  /*
    Radial shatter. Real glass broken from a point cracks outward, so the
    Voronoi lattice is built in a warped space -- angle around the impact
    against distance from it -- which stretches cells into radial slivers
    near the break and lets them widen further out. A plain isotropic
    Voronoi reads as crazy paving, not as impact.

    Returns: xy = offset to the cell's site, z = cell id, w = distance to the
    nearest cell edge (for drawing the crack itself).
  */
  vec4 shatterCell(vec2 uv) {
    vec2 d = uv - uImpact;
    float r = length(d);
    float a = atan(d.y, d.x);

    // Cell density rises close to the impact: more, finer shards there.
    vec2 warped = vec2(a * (2.2 + 6.0 * r), pow(r, 0.65) * 9.0);

    vec2 cell = floor(warped);
    vec2 frac = fract(warped);

    float bestDist = 8.0;
    float secondDist = 8.0;
    vec2 bestOffset = vec2(0.0);
    vec2 bestSite = vec2(0.0);

    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 neighbour = vec2(float(x), float(y));
        vec2 site = neighbour + hash2(cell + neighbour) - frac;
        float dist = dot(site, site);

        if (dist < bestDist) {
          secondDist = bestDist;
          bestDist = dist;
          bestOffset = site;
          bestSite = cell + neighbour;
        } else if (dist < secondDist) {
          secondDist = dist;
        }
      }
    }

    // Distance to the edge midway between the two nearest sites.
    float edge = sqrt(secondDist) - sqrt(bestDist);
    float id = fract(sin(dot(bestSite, vec2(12.9898, 78.233))) * 43758.5453);

    return vec4(bestOffset, id, edge);
  }

  void main() {
    // Shards are laid out in aspect-corrected space so they are not stretched
    // on a wide viewport. The background does its own correction from uAspect
    // for the same reason, so both stay round; only the sampling coordinates
    // handed to it stay in raw uv.
    float aspect = uResolution.x / max(uResolution.y, 1.0);
    vec2 uv = vUv;
    vec2 auv = vec2((uv.x - 0.5) * aspect + 0.5, uv.y);

    float t = uTime * uMotion;

    vec4 cell = shatterCell(auv);
    float shardId = cell.z;
    float edge = cell.w;

    /*
      Each shard is a slightly tilted glass plate. The tilt is fixed per
      shard (hashed from its id) so the pane reads as solid: a shard that
      wobbled independently would look like water, not glass.
    */
    vec2 tilt = (hash2(vec2(shardId, shardId * 3.7)) - 0.5) * 0.55;

    // Dispersal: shards fly outward from the impact, rotating as they go.
    // Near shards leave first, which is what makes it read as a shockwave
    // rather than a uniform fade.
    vec2 fromImpact = auv - uImpact;
    float travelDelay = clamp(length(fromImpact) * 0.9, 0.0, 0.85);
    float shardProgress = clamp((uDisperse - travelDelay) / max(1.0 - travelDelay, 0.001), 0.0, 1.0);
    float eased = shardProgress * shardProgress * (3.0 - 2.0 * shardProgress);

    // As a shard leaves it also tilts harder, throwing its refraction off
    // before it fades -- the glint you get off a fragment turning in the air.
    tilt += normalize(fromImpact + 1e-5) * eased * 1.6;

    /*
      Refraction. The plate normal is the tilt lifted into 3D; refract() against
      a straight-on view ray gives the bent direction, and its xy is the offset
      we sample the background at. Thickness scales the offset -- thicker glass
      displaces more.
    */
    vec3 normal = normalize(vec3(tilt, 1.0));
    vec3 viewRay = vec3(0.0, 0.0, -1.0);
    vec3 bent = refract(viewRay, normal, 1.0 / 1.52); // 1.52 = crown glass
    vec2 refracted = uv + bent.xy * 0.09 * (1.0 - eased * 0.35);

    /*
      Caustics. The area a bundle of neighbouring rays lands in, after being
      bent, is the determinant of the mapping's Jacobian. Small area means the
      rays converged and the light is concentrated; large area means it spread
      out. This is the actual physical term, read straight off screen-space
      derivatives of the refracted coordinate.
    */
    vec2 dx = dFdx(refracted);
    vec2 dy = dFdy(refracted);
    float jacobian = abs(dx.x * dy.y - dx.y * dy.x);
    float spread = jacobian * uResolution.x * uResolution.y;
    float caustic = clamp(0.16 / (spread + 0.16), 0.0, 1.0);

    // Chromatic dispersion: the three channels take slightly different paths,
    // which is what puts the colour fringe on a real glass edge.
    float r = workspaceBackground(uv + bent.xy * 0.094 * (1.0 - eased * 0.35), t).r;
    vec3 g = workspaceBackground(refracted, t);
    float b = workspaceBackground(uv + bent.xy * 0.086 * (1.0 - eased * 0.35), t).b;
    vec3 through = vec3(r, g.g, b);

    // The caustic brightens the transmitted light rather than being added on
    // top of it, so it stays inside the glass instead of hazing the page.
    through += through * caustic * 0.85;

    // Fresnel: glancing angles reflect more, which is what gives a shard its
    // bright rim without drawing one.
    float fresnel = pow(1.0 - abs(normal.z), 3.0);
    through += vec3(fresnel) * 0.22;

    /*
      The crack itself. A purely additive highlight is invisible here: the
      ground is white, so adding light to it does nothing and the pane only
      appears where a sphere happens to sit behind it. A real crack in glass
      reads as a *dark* fracture line carrying a bright specular glint along
      its centre, so it is drawn as both -- the shoulder darkens, the core
      lights up. That is what makes the pane legible across the whole
      viewport instead of only over the colour.
    */
    float crack = 1.0 - smoothstep(0.0, 0.05, edge);
    float crackCore = 1.0 - smoothstep(0.0, 0.014, edge);
    through -= vec3(crack) * 0.085;
    through += vec3(crackCore) * 0.34;

    // Ground truth: what the page looks like once the glass has gone.
    vec3 bare = workspaceBackground(uv, t);

    // Each shard fades on its own schedule as it flies.
    vec3 col = mix(through, bare, eased);

    fragColour = vec4(col, 1.0);
  }
`;

export interface ShatteredGlassOptions {
  palette: GlassPalette;
  /** Where the pane breaks, in 0..1 viewport coords. Defaults to centre-top. */
  impact?: [number, number];
}

export interface ShatteredGlassHandle {
  /**
   * Break the pane and clear it to the edges. Resolves once the workspace is
   * fully revealed, so a caller can sequence the next screen against it.
   */
  disperse(durationMs?: number): Promise<void>;
  /** Put the pane back — used when the day rolls over, or on demand. */
  reassemble(durationMs?: number): Promise<void>;
  destroy(): void;
}

/**
 * Mount the hero onto a canvas.
 *
 * Returns `null` when WebGL2 is unavailable or the context is lost — the
 * caller is expected to leave its CSS fallback in place rather than showing
 * an empty canvas. The reason is reported, never swallowed (CLAUDE.md).
 */
export function mountShatteredGlass(
  canvas: HTMLCanvasElement,
  options: ShatteredGlassOptions,
): ShatteredGlassHandle | null {
  const reducedMotion = prefersReducedMotion();

  const uniforms = {
    uResolution: { value: new Vector2(1, 1) },
    uTime: { value: 0 },
    uDisperse: { value: 0 },
    uImpact: { value: new Vector2(options.impact?.[0] ?? 0.5, options.impact?.[1] ?? 0.62) },
    uMotion: { value: reducedMotion ? 0 : 1 },
    uAspect: { value: 1 },
    uGround: { value: new Vector3(...options.palette.ground) },
    uOrbColours: { value: options.palette.orbs.map((c) => new Vector3(...c)) },
    uOrbCentres: { value: ORB_CENTRES.map(([x, y]) => new Vector2(x, y)) },
    uOrbRadii: { value: ORB_RADII },
    uOrbSpeeds: { value: ORB_SPEEDS },
  };

  /*
    The loop runs even under reduced motion, unlike the workspace orbs. The
    pane still has to *disperse* on sign-in — that is a state change the
    operator is waiting on, not decoration — and uMotion=0 already stills the
    drift inside the shader, so what reduced motion gets is a cut to the
    cleared workspace rather than a canvas that never updates again.
  */
  const shader = mountFullscreenShader(canvas, {
    label: "shattered-glass",
    fragmentShader: FRAGMENT_SHADER,
    uniforms,
    onResize: (width, height) => {
      uniforms.uResolution.value.set(width, height);
      uniforms.uAspect.value = width / Math.max(height, 1);
    },
    onFrame: (elapsed) => {
      uniforms.uTime.value = elapsed;
    },
  });

  if (!shader) return null;

  /** Drive uDisperse from `from` to `to`, resolving when it lands. */
  const animateTo = (from: number, to: number, durationMs: number): Promise<void> => {
    if (reducedMotion) {
      uniforms.uDisperse.value = to;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const started = performance.now();
      const step = (now: number): void => {
        const progress = Math.min((now - started) / durationMs, 1);
        // Ease-out cubic: the shards leave fast and settle, rather than
        // drifting off at a constant speed.
        uniforms.uDisperse.value = from + (to - from) * (1 - Math.pow(1 - progress, 3));
        if (progress < 1) {
          requestAnimationFrame(step);
        } else {
          resolve();
        }
      };
      requestAnimationFrame(step);
    });
  };

  return {
    disperse: (durationMs = 1400) => animateTo(uniforms.uDisperse.value, 1, durationMs),
    reassemble: (durationMs = 1100) => animateTo(uniforms.uDisperse.value, 0, durationMs),
    destroy: () => shader.destroy(),
  };
}
