#!/usr/bin/env node
// Client/server isolation for the operator surface.
//
// This used to enforce CONSOLE_SPEC.md §5's "no src/pages/** imports from
// src/console/**" rule, in both directions. Both of those directories are
// gone: the 2026-08-31 overhaul collapsed the console into one React
// surface at src/app/**, mounted client:only from src/pages/index.astro.
//
// The rule worth keeping is the security-relevant one, and it is stricter
// than what it replaces: src/app/** ships to the browser, so it must never
// import from src/server/** or db/**. Either would pull route handlers,
// D1 schema, or — via the vault — key-decryption code into a bundle that
// is served to anyone who loads the page. The API contract crosses that
// boundary as *types only*, restated in src/app/types.ts.
//
// Deliberately a small deterministic grep rather than dependency-cruiser,
// whose .astro frontmatter coverage was never verified here (see
// docs/DECISIONS.md's Phase 7 entry) — same "don't fake a validated
// approach" discipline used elsewhere in this project.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const IMPORT_PATH_RE = /(?:from\s+|import\s+)["']([^"']+)["']/g;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx|astro)$/.test(entry)) out.push(full);
  }
  return out;
}

const FORBIDDEN = [
  { fragment: "/server/", why: "server route handlers and their secrets must never reach the client bundle" },
  { fragment: "db/schema", why: "the D1 schema is server-side; the client speaks the JSON contract in src/app/types.ts" },
  { fragment: "/vault", why: "key material decryption must never be reachable from the browser" },
];

const violations = [];
for (const file of walk(join(ROOT, "src/app"))) {
  const contents = readFileSync(file, "utf8");
  for (const match of contents.matchAll(IMPORT_PATH_RE)) {
    const importPath = match[1];
    for (const { fragment, why } of FORBIDDEN) {
      if (importPath.includes(fragment)) {
        violations.push(`${relative(ROOT, file)} imports "${importPath}" — ${why}`);
      }
    }
  }
}

if (violations.length > 0) {
  console.error("✗ client/server isolation violated:");
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}

console.log("✓ client/server isolation: src/app/** imports nothing from src/server/**, db/schema, or the vault");
