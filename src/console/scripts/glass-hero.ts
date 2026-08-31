/*
  Mounts the shattered-glass hero on the login page and clears it on a
  successful sign-in (plan v2 §7: "on login the glass disperses to the edges,
  leaving a white workspace").

  The palette is read off computed style rather than passed in, so tokens.css
  stays the single source of colour (CLAUDE.md) and a palette change needs no
  edit here.
*/
import { mountShatteredGlass, type GlassPalette, type ShatteredGlassHandle } from "../../shaders/shattered-glass";

/** `#rrggbb` / `#rgb` to linear 0..1 triples. */
function parseHex(value: string): [number, number, number] | null {
  const hex = value.trim().replace(/^#/, "");
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return [
    parseInt(full.slice(0, 2), 16) / 255,
    parseInt(full.slice(2, 4), 16) / 255,
    parseInt(full.slice(4, 6), 16) / 255,
  ];
}

function readPalette(): GlassPalette | null {
  const style = getComputedStyle(document.documentElement);
  const ground = parseHex(style.getPropertyValue("--ink"));
  const orbs = (["--orb-1", "--orb-2", "--orb-3", "--orb-4"] as const).map((name) =>
    parseHex(style.getPropertyValue(name)),
  );

  if (!ground || orbs.some((orb) => orb === null)) {
    // Not a swallowed failure: say which tokens are missing and let the
    // caller keep its CSS fallback rather than rendering a black rectangle.
    console.warn("glass-hero: palette tokens missing from tokens.css, keeping the static fallback");
    return null;
  }

  return { ground, orbs: orbs as [number, number, number][] };
}

export function initGlassHero(): ShatteredGlassHandle | null {
  const canvas = document.getElementById("glass-hero");
  if (!(canvas instanceof HTMLCanvasElement)) return null;

  const palette = readPalette();
  if (!palette) return null;

  const handle = mountShatteredGlass(canvas, { palette });
  if (!handle) return null;

  // Reveal only once the shader owns the pixels, so the CSS fallback is never
  // visibly swapped out mid-paint.
  canvas.dataset.ready = "true";

  /*
    login.ts dispatches this after the passkey ceremony resolves and before it
    navigates. Waiting on the dispersal means the operator sees the glass
    clear rather than the page cutting away mid-animation.
  */
  document.addEventListener(
    "mythos:signed-in",
    () => {
      void handle.disperse().then(() => {
        document.dispatchEvent(new CustomEvent("mythos:glass-cleared"));
      });
    },
    { once: true },
  );

  return handle;
}
