// The real "Liquid Metal" shader from @paper-design/shaders (the same
// engine 21st.dev's "Liquid Metal Hero" — chowlol202, id 5808 — is built
// on via its React wrapper). Used here through the framework-agnostic core
// package directly, matching this project's existing "no React anywhere"
// pattern (src/scripts/hero-orb.ts uses ogl the same way) rather than
// pulling in @paper-design/shaders-react, which exists only to bind this
// same class to React state. See docs/DECISIONS.md for the full reasoning.
import {
  ShaderMount,
  liquidMetalFragmentShader,
  LiquidMetalShapes,
  ShaderFitOptions,
  getShaderColorFromString,
  defaultObjectSizing,
  emptyPixel,
  type LiquidMetalShape,
} from "@paper-design/shaders";

export interface LiquidMetalOptions {
  colorBack?: string;
  colorTint?: string;
  softness?: number;
  repetition?: number;
  shiftRed?: number;
  shiftBlue?: number;
  distortion?: number;
  contour?: number;
  angle?: number;
  shape?: LiquidMetalShape;
  scale?: number;
  speed?: number;
}

// The demo's `liquidMetalPresets[2]` ("Backdrop") — a full-bleed, shapeless
// (u_shape: none) metal surface, the one actually used behind hero copy
// rather than as a bounded logo-shaped mark.
const BACKDROP_PRESET: Required<LiquidMetalOptions> = {
  colorBack: "#AAAAAC",
  colorTint: "#ffffff",
  softness: 0.05,
  repetition: 1.5,
  shiftRed: 0.3,
  shiftBlue: 0.3,
  distortion: 0.1,
  contour: 0.4,
  angle: 90,
  shape: "none",
  scale: 1,
  speed: 1,
};

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load ${url}`));
    img.src = url;
  });
}

/**
 * Mounts the liquid-metal shader into `container` (a real DOM element the
 * shader appends its own <canvas> into — ShaderMount's own behavior, same
 * as every other paper-design shader). Returns a disposer. Resolves once
 * the (tiny, local, data-URI) placeholder texture has loaded — there is no
 * network fetch here, `u_isImage` stays false throughout.
 */
export async function mountLiquidMetal(container: HTMLElement, options: LiquidMetalOptions = {}): Promise<() => void> {
  const params = { ...BACKDROP_PRESET, ...options };
  const image = await loadImage(emptyPixel);

  const uniforms = {
    u_colorBack: getShaderColorFromString(params.colorBack),
    u_colorTint: getShaderColorFromString(params.colorTint),
    u_image: image,
    u_contour: params.contour,
    u_distortion: params.distortion,
    u_softness: params.softness,
    u_repetition: params.repetition,
    u_shiftRed: params.shiftRed,
    u_shiftBlue: params.shiftBlue,
    u_angle: params.angle,
    u_isImage: false,
    u_shape: LiquidMetalShapes[params.shape],
    u_fit: ShaderFitOptions[defaultObjectSizing.fit],
    u_scale: params.scale,
    u_rotation: defaultObjectSizing.rotation,
    u_offsetX: defaultObjectSizing.offsetX,
    u_offsetY: defaultObjectSizing.offsetY,
    u_originX: defaultObjectSizing.originX,
    u_originY: defaultObjectSizing.originY,
    u_worldWidth: defaultObjectSizing.worldWidth,
    u_worldHeight: defaultObjectSizing.worldHeight,
  };

  let mount: ShaderMount;
  try {
    mount = new ShaderMount(container, liquidMetalFragmentShader, uniforms, undefined, params.speed, 0, 2, undefined, ["u_image"]);
  } catch {
    return () => {};
  }

  return () => mount.dispose();
}
