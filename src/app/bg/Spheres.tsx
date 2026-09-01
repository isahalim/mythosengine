/**
 * The ground: big soft rainbow spheres drifting around the centre.
 *
 * Board 1: "soft gradient rainbow spheres actually MOVING around the
 * center like lava lamps ... make them big ... use other colors, rotate,
 * collide, merge, combine colors."
 *
 * Canvas 2D rather than WebGL, for one reason that decides the whole
 * thing: `globalCompositeOperation = "multiply"`. Each sphere is painted
 * as a radial gradient running from its own colour out to WHITE, and white
 * is multiply's identity — so a sphere leaves the page untouched at its
 * rim and fully coloured at its core, and where two overlap the result is
 * the *product* of the two colours. Amber over teal genuinely resolves
 * green. That is "combine colors" done by the compositor, physically,
 * rather than faked with a third hand-picked hue.
 *
 * Colours are read off computed style (tokens.css --orb-1..6) rather than
 * repeated here, so the palette has exactly one home.
 */
import { useEffect, useRef } from "react";

interface Sphere {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  /** RGB, mutated on collision so colliding spheres genuinely trade colour. */
  rgb: [number, number, number];
  /**
   * The hue this sphere relaxes back toward. Without it the palette dies:
   * contact mixes every sphere toward every other, and six hues converge
   * to one muddy average within seconds. Mixing on contact plus a slow
   * pull home is what keeps the rainbow a rainbow while still genuinely
   * combining colours where spheres meet.
   */
  home: [number, number, number];
  /** Where the gradient's hot spot sits inside the sphere, and how fast it orbits — the lava-lamp roll. */
  phase: number;
  spin: number;
  /** This sphere's own offset into the breathing cycle, so the six never swell in unison. */
  breath: number;
  /** Seed for this sphere's wander terms — fixed per sphere, so its path is its own. */
  drift: number;
}

const COUNT = 6;
/** Sphere radius as a fraction of the smaller viewport axis. Big, per the board. */
const R_MIN = 0.26;
const R_MAX = 0.44;
/**
 * Fraction of the smaller viewport axis travelled per second.
 *
 * This has been wrong in both directions. At 0.05 the field read as
 * stationary — a ~700px sphere blurred by 46px crossing 45px/s changes
 * nothing about its own silhouette from one second to the next. At 0.16 it
 * was perceptible and distracting: six saturated shapes crossing the
 * viewport in about six seconds, behind text and behind the glass the
 * operator is actually trying to look at.
 *
 * 0.055 is slower than either, and the field still reads as moving,
 * because translation is no longer the only thing changing. BREATHE (below)
 * makes each sphere's radius swell and contract, and the two wander terms
 * push it off any straight line — so the silhouette is continuously
 * deforming even when the centre has barely travelled. That is what reads
 * as fluid, and it is legible at a speed at which pure translation is not.
 */
const SPEED = 0.055;
/** Per second, at full overlap: how fast two touching spheres trade colour. */
const MIX_RATE = 0.6;
/** Per second: how fast a sphere drifts back to its own hue once it is clear again. */
const HOME_RATE = 0.35;
/**
 * Slow independent wander, layered on top of the ballistic motion. Two
 * incommensurable sine terms per axis, so a sphere's path never closes
 * into a loop and the field never settles into a pattern the eye can
 * predict — which is the other half of why the old version looked static:
 * six spheres bouncing elastically in a box reach a stable orbit fast.
 *
 * Amplitude and frequency both come down with SPEED. Keeping the old
 * frequencies at a lower amplitude would have made the wander a jitter;
 * dividing them by roughly three keeps each excursion long and unhurried,
 * which is the difference between drifting and vibrating.
 */
const WANDER = 0.05;
/**
 * How far a sphere's radius swells and shrinks, as a fraction of itself,
 * and how many radians per second it does it in. This is the fluidity: a
 * lava lamp's blobs are not rigid discs sliding around, they change shape,
 * and at a low SPEED that shape change is most of the perceived motion.
 * Overlaps breathe in and out with it, so the multiply-blended colour where
 * two spheres meet keeps shifting even when neither has moved far.
 */
const BREATHE = 0.16;
const BREATHE_RATE = 0.085;

function readOrbColors(): [number, number, number][] {
  const style = getComputedStyle(document.documentElement);
  const out: [number, number, number][] = [];
  for (let i = 1; i <= COUNT; i++) {
    const raw = style.getPropertyValue(`--orb-${i}`).trim();
    const hex = raw.startsWith("#") ? raw.slice(1) : raw;
    if (hex.length !== 6) continue;
    out.push([parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)]);
  }
  return out;
}

function rgbCss([r, g, b]: [number, number, number], alpha: number): string {
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${alpha})`;
}

export function Spheres() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;

    const colors = readOrbColors();
    if (colors.length === 0) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let w = 0;
    let h = 0;
    let unit = 0;
    let spheres: Sphere[] = [];

    const resize = (): void => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth;
      h = window.innerHeight;
      unit = Math.min(w, h);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const seed = (): void => {
      spheres = colors.map((rgb, i) => {
        // Seeded on a ring around the centre, so they start "around the
        // center" and orbit it rather than filling the page at random.
        const angle = (i / colors.length) * Math.PI * 2;
        const orbit = unit * 0.32;
        const dir = angle + Math.PI / 2;
        return {
          x: w / 2 + Math.cos(angle) * orbit,
          y: h / 2 + Math.sin(angle) * orbit,
          vx: Math.cos(dir) * unit * SPEED,
          vy: Math.sin(dir) * unit * SPEED,
          r: unit * (R_MIN + ((i * 0.37) % 1) * (R_MAX - R_MIN)),
          rgb: [...rgb] as [number, number, number],
          home: [...rgb] as [number, number, number],
          phase: angle,
          // Roughly a third of the old rate, for the same reason as SPEED:
          // a hot spot racing around inside a soft sphere is the detail
          // that made the background pull the eye.
          spin: 0.055 + ((i * 0.23) % 1) * 0.1,
          breath: angle * 1.37 + i,
          drift: i * 1.7 + 0.4,
        };
      });
    };

    resize();
    seed();
    window.addEventListener("resize", resize);

    /** Seconds of animated time. Read by both `draw` (breathing) and `step` (wander), so it is declared ahead of both. */
    let clock = 0;

    const draw = (): void => {
      // Multiply needs an opaque white ground to be a no-op against.
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = "multiply";

      for (const s of spheres) {
        // The drawn radius, not the stored one: `s.r` is this sphere's rest
        // size and stays the collision radius, so breathing changes what
        // the operator sees without making contact events pulse with it.
        const r = s.r * (1 + Math.sin(clock * BREATHE_RATE + s.breath) * BREATHE);
        // The gradient's hot spot orbits inside the sphere — that offset,
        // moving, is what reads as a lava lamp rather than a flat disc.
        const ox = s.x + Math.cos(s.phase) * r * 0.28;
        const oy = s.y + Math.sin(s.phase) * r * 0.28;
        const g = ctx.createRadialGradient(ox, oy, 0, s.x, s.y, r);
        g.addColorStop(0, rgbCss(s.rgb, 0.62));
        g.addColorStop(0.5, rgbCss(s.rgb, 0.5));
        g.addColorStop(0.8, rgbCss(s.rgb, 0.2));
        // White = multiply identity, so the sphere dissolves into the page
        // instead of ending on a visible edge.
        g.addColorStop(1, "rgba(255, 255, 255, 0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalCompositeOperation = "source-over";
    };

    const step = (dt: number): void => {
      clock += dt;
      for (const s of spheres) {
        // Ballistic motion plus an open wander. The wander is what stops
        // the field settling into a repeating orbit.
        const wx = Math.sin(clock * 0.072 + s.drift) + 0.6 * Math.sin(clock * 0.127 + s.drift * 2.3);
        const wy = Math.cos(clock * 0.058 + s.drift * 1.4) + 0.6 * Math.cos(clock * 0.141 + s.drift);
        s.x += (s.vx + wx * unit * WANDER) * dt;
        s.y += (s.vy + wy * unit * WANDER) * dt;
        s.phase += s.spin * dt;

        // A gentle pull back toward the centre keeps the composition
        // "around the center" instead of letting the spheres park in the
        // corners, without ever bringing them to rest there.
        s.vx += (w / 2 - s.x) * 0.05 * dt;
        s.vy += (h / 2 - s.y) * 0.05 * dt;

        // Relax toward this sphere's own hue, so contact-mixing is a
        // visible event rather than a one-way slide into grey.
        for (let c = 0; c < 3; c++) s.rgb[c] += (s.home[c] - s.rgb[c]) * HOME_RATE * dt;

        // Bounce off the viewport at the sphere's core, not its rim — the
        // soft edge is meant to run off-screen.
        const m = s.r * 0.45;
        if (s.x < m && s.vx < 0) s.vx = -s.vx;
        if (s.x > w - m && s.vx > 0) s.vx = -s.vx;
        if (s.y < m && s.vy < 0) s.vy = -s.vy;
        if (s.y > h - m && s.vy > 0) s.vy = -s.vy;
      }

      // Elastic collisions (equal mass), plus the merge: on contact each
      // sphere's colour eases a little toward the other's, so over minutes
      // the palette genuinely mixes instead of six fixed hues passing
      // through each other forever.
      for (let i = 0; i < spheres.length; i++) {
        for (let j = i + 1; j < spheres.length; j++) {
          const a = spheres[i];
          const b = spheres[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dist = Math.hypot(dx, dy);
          const touch = (a.r + b.r) * 0.62;
          if (dist === 0 || dist >= touch) continue;

          const nx = dx / dist;
          const ny = dy / dist;
          const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
          if (rel < 0) {
            a.vx += rel * nx;
            a.vy += rel * ny;
            b.vx -= rel * nx;
            b.vy -= rel * ny;
          }

          // Depth of overlap drives how much colour transfers, so a
          // glancing pass barely tints and a head-on merge really blends.
          // Rate is per SECOND, scaled by dt — as a raw per-frame constant
          // this ran ~60x faster than intended and flattened the whole
          // palette to one hue within about two seconds.
          const blend = (1 - dist / touch) * MIX_RATE * dt;
          for (let c = 0; c < 3; c++) {
            const av = a.rgb[c];
            const bv = b.rgb[c];
            a.rgb[c] = av + (bv - av) * blend;
            b.rgb[c] = bv + (av - bv) * blend;
          }
        }
      }
    };

    if (reduced) {
      // Still a composition, just a still one.
      draw();
      return () => window.removeEventListener("resize", resize);
    }

    let raf = 0;
    let last = performance.now();
    const frame = (now: number): void => {
      // Clamped so a backgrounded tab returning after a minute does not
      // integrate one enormous step and fling every sphere off-screen.
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      step(dt);
      draw();
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <>
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 -z-10"
      // The blur is what turns six hard discs into soft light. Done in CSS
      // so the GPU does it once per frame on the composited layer rather
      // than the CPU doing it per-pixel in the 2D context.
      // Fainter, per operator direction: the spheres are the room's light,
      // not the subject. The glass in front of them is the subject.
      style={{ filter: "blur(46px) saturate(1.1)", opacity: 0.68 }}
    />
    <div className="sphere-veil" aria-hidden="true" />
    </>
  );
}
