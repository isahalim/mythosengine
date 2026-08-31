/*
  Reads the shader palette off computed style, so tokens.css stays the single
  source of colour (CLAUDE.md: it is the only file allowed to declare raw
  hex) and a palette change needs no edit in any shader.

  Shared by the login hero and the workspace ground: both draw the same
  spheres, so both must resolve the same tokens by the same rules.
*/
import type { GlassPalette } from "../../shaders/glass-background.glsl";

/**
 * `#rrggbb` / `#rgb` to 0..1 triples.
 *
 * Exported for its test: this is the one step that can quietly turn a valid
 * palette into a null, and the whole fallback contract hangs off it.
 */
export function parseHex(value: string): [number, number, number] | null {
  const hex = value.trim().replace(/^#/, "");
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return [
    parseInt(full.slice(0, 2), 16) / 255,
    parseInt(full.slice(2, 4), 16) / 255,
    parseInt(full.slice(4, 6), 16) / 255,
  ];
}

/**
 * Resolve `--ink` and `--orb-1..4` into a shader palette.
 *
 * Returns `null` — with the reason logged, never swallowed — when a token is
 * missing or unparseable, so the caller keeps its CSS fallback rather than
 * mounting a shader that renders a black rectangle.
 */
export function readGlassPalette(label: string): GlassPalette | null {
  const style = getComputedStyle(document.documentElement);
  const ground = parseHex(style.getPropertyValue("--ink"));
  const orbs = (["--orb-1", "--orb-2", "--orb-3", "--orb-4"] as const).map((name) =>
    parseHex(style.getPropertyValue(name)),
  );

  if (!ground || orbs.some((orb) => orb === null)) {
    console.warn(`${label}: palette tokens missing from tokens.css, keeping the static fallback`);
    return null;
  }

  return { ground, orbs: orbs as [number, number, number][] };
}
