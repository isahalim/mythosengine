/*
  Shared mounting for the console's full-screen shader canvases — the
  shattered-glass hero (`shattered-glass.ts`) and the workspace orbs
  (`workspace-orbs.ts`).

  Both draw a single program over a single clip-space triangle, and both need
  the same five things right. Four are ordinary: fail soft when WebGL2 is
  missing, cap the device pixel ratio, re-size with the viewport, and stop
  the loop while the tab is hidden.

  The fifth is the one that is easy to get wrong, and is the reason this file
  exists rather than a second copy of the boilerplate. A shader that fails to
  compile does not throw — three logs it, and every subsequent frame raises
  INVALID_OPERATION ("no valid shader program in use") at 60fps behind a
  canvas the viewer just sees as blank. Rendering one frame and reading the
  GL error is what turns that silent spin into a clean fallback, and it
  belongs somewhere neither caller can forget it.
*/
import {
  BufferAttribute,
  BufferGeometry,
  GLSL3,
  Mesh,
  OrthographicCamera,
  RawShaderMaterial,
  Scene,
  Timer,
  WebGLRenderer,
  type IUniform,
} from "three";

// No `#version` line: `glslVersion: GLSL3` below makes three prepend
// `#version 300 es` itself, and a second one fails to compile — "#version
// directive must occur before anything else".
const VERTEX_SHADER = /* glsl */ `
  precision highp float;

  // A single triangle large enough to cover clip space. Cheaper than a quad
  // (no shared edge, one fewer vertex, no diagonal seam) and it needs no
  // camera matrices at all -- position is already in clip space.
  in vec3 position;
  out vec2 vUv;

  void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

export interface FullscreenShaderOptions<U extends Record<string, IUniform>> {
  /** Used in the console warning when the program will not link. */
  label: string;
  fragmentShader: string;
  uniforms: U;
  /** Push the new size into whatever uniforms the caller named it. */
  onResize?(width: number, height: number): void;
  /** Per-frame uniform updates. Not called when `animate` is false. */
  onFrame?(elapsedSeconds: number): void;
  /**
   * Run the animation loop. False renders the verification frame and stops
   * there — which is exactly the right output for a static background under
   * `prefers-reduced-motion`, rather than redrawing an identical frame 60
   * times a second.
   */
  animate?: boolean;
}

export interface FullscreenShaderHandle<U extends Record<string, IUniform>> {
  uniforms: U;
  /** Draw one frame now. For callers that mutate uniforms outside the loop. */
  renderOnce(): void;
  destroy(): void;
}

/** True when the viewer has asked the OS for less motion. */
export function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Mount one fragment shader across `canvas`.
 *
 * Returns `null` when WebGL2 is unavailable or the program fails to link —
 * the caller is expected to leave its CSS fallback in place rather than show
 * an empty canvas. The reason is always reported, never swallowed.
 */
export function mountFullscreenShader<U extends Record<string, IUniform>>(
  canvas: HTMLCanvasElement,
  options: FullscreenShaderOptions<U>,
): FullscreenShaderHandle<U> | null {
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: "low-power" });
  } catch (cause) {
    console.warn(`${options.label}: WebGL unavailable, keeping the static fallback`, cause);
    return null;
  }

  const scene = new Scene();
  const camera = new OrthographicCamera();

  // Clip-space triangle: (-1,-1), (3,-1), (-1,3) covers the viewport with a
  // single primitive and no diagonal seam through the middle of the shader.
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));

  const material = new RawShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: options.fragmentShader,
    glslVersion: GLSL3,
    uniforms: options.uniforms,
    depthTest: false,
    depthWrite: false,
  });

  const mesh = new Mesh(geometry, material);
  // The triangle is already in clip space, so three's frustum test would
  // wrongly cull it.
  mesh.frustumCulled = false;
  scene.add(mesh);

  /*
    Timer, not Clock — Clock is deprecated in three 0.185, and Timer is also
    the better fit here. Connected to the document it uses the Page Visibility
    API to clamp the delta across a hidden tab, so elapsed time does not run
    on while nothing is being drawn. Coming back to a console tab left open
    for an hour resumes the drift exactly where it stopped, instead of
    teleporting the spheres an hour downstream in one frame.
  */
  const timer = new Timer();
  timer.connect(document);
  let frame = 0;
  let destroyed = false;

  const resize = (): void => {
    const width = canvas.clientWidth || window.innerWidth;
    const height = canvas.clientHeight || window.innerHeight;
    // Cap the device pixel ratio: these shaders are fill-rate bound, and past
    // 2x the extra pixels buy nothing a viewer can see.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height, false);
    options.onResize?.(width, height);
  };

  const renderOnce = (): void => {
    if (destroyed) return;
    renderer.render(scene, camera);
  };

  const tick = (): void => {
    if (destroyed) return;
    timer.update();
    options.onFrame?.(timer.getElapsed());
    renderer.render(scene, camera);
    frame = requestAnimationFrame(tick);
  };

  const stop = (): void => {
    cancelAnimationFrame(frame);
    frame = 0;
  };

  const onContextLost = (event: Event): void => {
    event.preventDefault();
    console.warn(`${options.label}: WebGL context lost, animation stopped`);
    stop();
  };

  /*
    A console tab is left open all day. Painting a full-screen shader into a
    backgrounded tab costs the operator battery for pixels nobody is looking
    at, so the loop parks itself while the tab is hidden. The timer above
    parks with it, which is what makes coming back seamless rather than a
    jump-cut.
  */
  const onVisibilityChange = (): void => {
    if (destroyed || options.animate === false) return;
    if (document.hidden) stop();
    else if (frame === 0) tick();
  };

  const teardown = (): void => {
    timer.disconnect();
    canvas.removeEventListener("webglcontextlost", onContextLost);
    window.removeEventListener("resize", resize);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    geometry.dispose();
    material.dispose();
    renderer.dispose();
  };

  canvas.addEventListener("webglcontextlost", onContextLost);
  window.addEventListener("resize", resize);
  document.addEventListener("visibilitychange", onVisibilityChange);
  resize();

  // Prove the program linked before starting the loop — see the header.
  options.onFrame?.(0);
  renderer.render(scene, camera);
  const gl = renderer.getContext();
  const glError = gl.getError();
  if (glError !== gl.NO_ERROR) {
    console.warn(`${options.label}: shader program failed to link (GL error ${glError}), keeping the static fallback`);
    teardown();
    return null;
  }

  if (options.animate !== false) tick();

  return {
    uniforms: options.uniforms,
    renderOnce,
    destroy: () => {
      destroyed = true;
      stop();
      teardown();
    },
  };
}
