// Public-homepage hero (docs/DECISIONS.md, 2026-08-28: reverses Phase 7's
// "no public hero" call — this is the console's opposite number, its own
// bundle, its own budget). A raymarched "liquid metal" orb, tier 2 over
// src/components/HeroOrb.astro's tier-1 static SVG poster: WebGL absent,
// `prefers-reduced-motion`, or a lost context all just mean the poster
// stays visible and this module never mounts a canvas over it.
import { Mesh, Program, Renderer, Triangle } from "ogl";

const VERTEX = `
  attribute vec2 uv;
  attribute vec2 position;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position, 0.0, 1.0);
  }
`;

// Raymarched sphere, gently warped for a "liquid" feel, colored by the
// existing oxide -> sodium -> violet gradient (tokens.css --gradient-accent)
// rather than an arbitrary palette — the hero uses the same three hues the
// console's accent hairline already does, just animated and dimensional.
const FRAGMENT = `
  precision highp float;
  uniform float uTime;
  uniform vec2 uResolution;
  varying vec2 vUv;

  vec3 palette(float t) {
    vec3 oxide = vec3(0.184, 0.420, 0.341);
    vec3 sodium = vec3(0.910, 0.580, 0.290);
    vec3 violet = vec3(0.486, 0.435, 0.859);
    t = fract(t);
    if (t < 0.5) return mix(oxide, sodium, t * 2.0);
    return mix(sodium, violet, (t - 0.5) * 2.0);
  }

  float map(vec3 p) {
    float warp = sin(p.x * 3.0 + uTime) * 0.05
               + sin(p.y * 4.0 - uTime * 1.3) * 0.05
               + sin(p.z * 3.5 + uTime * 0.7) * 0.05;
    return length(p) - (1.0 + warp);
  }

  vec3 calcNormal(vec3 p) {
    vec2 e = vec2(0.001, 0.0);
    return normalize(vec3(
      map(p + e.xyy) - map(p - e.xyy),
      map(p + e.yxy) - map(p - e.yxy),
      map(p + e.yyx) - map(p - e.yyx)
    ));
  }

  void main() {
    vec2 uv = (vUv - 0.5) * 2.0;
    uv.x *= uResolution.x / uResolution.y;

    vec3 ro = vec3(0.0, 0.0, 3.0);
    vec3 rd = normalize(vec3(uv, -1.5));

    float t = 0.0;
    bool hit = false;
    vec3 p = ro;
    for (int i = 0; i < 64; i++) {
      p = ro + rd * t;
      float d = map(p);
      if (d < 0.001) { hit = true; break; }
      t += d;
      if (t > 6.0) break;
    }

    if (!hit) {
      gl_FragColor = vec4(0.0);
      return;
    }

    vec3 n = calcNormal(p);
    vec3 viewDir = normalize(ro - p);
    float fresnel = pow(1.0 - max(dot(n, viewDir), 0.0), 2.2);
    float gradientT = n.y * 0.5 + 0.5 + uTime * 0.05;
    vec3 base = palette(gradientT) * 0.22;
    vec3 rim = palette(gradientT + 0.3) * 1.3;
    vec3 col = mix(base, rim, fresnel);

    // Two lights: a broad fill for the fresnel rim above, plus a tight,
    // bright key light for the glossy "flare" a chrome/liquid-metal surface
    // needs to actually read as reflective rather than matte-shaded.
    vec3 lightDir = normalize(vec3(0.5, 0.8, 0.6));
    float spec = pow(max(dot(reflect(-lightDir, n), viewDir), 0.0), 24.0);
    vec3 keyDir = normalize(vec3(-0.6, 0.5, 0.4));
    float keySpec = pow(max(dot(reflect(-keyDir, n), viewDir), 0.0), 90.0);
    col += spec * 0.6 + keySpec * 1.4;

    gl_FragColor = vec4(col, 1.0);
  }
`;

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Mounts the WebGL orb over the static SVG poster (never removes the
 * poster — it stays as the paint the canvas sits on top of, and as the
 * only visible thing if any step here fails). Returns nothing to await;
 * every failure mode is a silent no-op, not a thrown error that could
 * break the rest of the page.
 */
export function initHeroOrb(canvas: HTMLCanvasElement): void {
  if (prefersReducedMotion()) return;

  let renderer: Renderer;
  try {
    renderer = new Renderer({ canvas, alpha: true, antialias: true, dpr: Math.min(window.devicePixelRatio, 2) });
  } catch {
    return; // no WebGL — the SVG poster underneath is the whole experience
  }

  const gl = renderer.gl;
  if (!gl) return;

  // Renderer.setSize() (called by ogl's own constructor, with its 300x150
  // default, before any of this runs) writes canvas.style.width/height as
  // inline styles — so canvas.clientWidth/clientHeight would just read back
  // whatever ogl last wrote there, not the CSS-driven size the surrounding
  // layout actually gives it. The parent element (this component's own
  // relative/aspect-square div) is never touched by ogl, so its bounding
  // box is the only size that reflects the real, current layout.
  const container = canvas.parentElement ?? canvas;

  const geometry = new Triangle(gl);
  const program = new Program(gl, {
    vertex: VERTEX,
    fragment: FRAGMENT,
    uniforms: { uTime: { value: 0 }, uResolution: { value: [1, 1] } },
    transparent: true,
    depthTest: false,
  });
  const mesh = new Mesh(gl, { geometry, program });

  function resize(): void {
    const { width, height } = container.getBoundingClientRect();
    if (width === 0 || height === 0) return;
    renderer.setSize(width, height);
    program.uniforms.uResolution.value = [width, height];
  }
  resize();
  window.addEventListener("resize", resize);

  let raf = 0;
  let visible = true;
  const observer = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
  });
  observer.observe(canvas);

  function tick(timeMs: number): void {
    raf = requestAnimationFrame(tick);
    if (!visible || document.visibilityState !== "visible") return;
    program.uniforms.uTime.value = timeMs * 0.001;
    renderer.render({ scene: mesh });
  }
  raf = requestAnimationFrame(tick);

  window.addEventListener(
    "pagehide",
    () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      window.removeEventListener("resize", resize);
    },
    { once: true },
  );
}
