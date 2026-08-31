/*
  Mounts the drifting lava-lamp spheres behind the console workspace (plan v2
  §7). Every console page except login gets these — login shows the
  shattered-glass hero instead, which refracts this same background and
  disperses to reveal it.

  Deliberately one canvas per page rather than one shared WebGL context: the
  console is a set of prerendered pages with full navigations between them,
  so there is nothing for a context to survive across. Mounting twice on one
  page is the case worth avoiding, and ConsoleLayout renders exactly one.
*/
import { mountWorkspaceOrbs, type WorkspaceOrbsHandle } from "../../shaders/workspace-orbs";
import { readGlassPalette } from "../lib/palette";

export function initWorkspaceBackground(): WorkspaceOrbsHandle | null {
  const canvas = document.getElementById("workspace-orbs");
  if (!(canvas instanceof HTMLCanvasElement)) return null;

  const palette = readGlassPalette("workspace-orbs");
  if (!palette) return null;

  const handle = mountWorkspaceOrbs(canvas, palette);
  if (!handle) return null;

  // Reveal only once the shader owns the pixels, so the CSS fallback beneath
  // is never visibly swapped out mid-paint.
  canvas.dataset.ready = "true";
  return handle;
}
