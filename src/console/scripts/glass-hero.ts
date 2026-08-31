/*
  Mounts the shattered-glass hero on the login page and clears it on a
  successful sign-in (plan v2 §7: "on login the glass disperses to the edges,
  leaving a white workspace").

  The palette comes from console/lib/palette.ts, which the workspace ground
  reads through too — both draw the same spheres, so both must resolve the
  same tokens.
*/
import { mountShatteredGlass, type ShatteredGlassHandle } from "../../shaders/shattered-glass";
import { readGlassPalette } from "../lib/palette";

export function initGlassHero(): ShatteredGlassHandle | null {
  const canvas = document.getElementById("glass-hero");
  if (!(canvas instanceof HTMLCanvasElement)) return null;

  const palette = readGlassPalette("glass-hero");
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
