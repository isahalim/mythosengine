#!/usr/bin/env node
// CONSOLE_SPEC.md §5: "keep the console bundle under 200KB gzip with a rule
// forbidding src/console/** imports from src/pages/**" (and, just as
// important the other direction: the public homepage bundle must never
// pull in console-only code). dependency-cruiser's .astro support wasn't
// verified in this session (see docs/DECISIONS.md's Phase 7 entry), so
// this is a small, deterministic grep-based check instead of a tool whose
// coverage of .astro frontmatter imports is unconfirmed — the same "don't
// fake a validated approach" discipline used elsewhere in this project.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const IMPORT_PATH_RE = /(?:from\s+|import\s+)["']([^"']+)["']/g;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|astro)$/.test(entry)) out.push(full);
  }
  return out;
}

function findForbiddenImports(files, forbiddenSubstring, exclude) {
  const violations = [];
  for (const file of files) {
    if (exclude(file)) continue;
    const contents = readFileSync(file, "utf8");
    for (const match of contents.matchAll(IMPORT_PATH_RE)) {
      const importPath = match[1];
      if (importPath.includes(forbiddenSubstring)) {
        violations.push(`${relative(ROOT, file)} imports "${importPath}"`);
      }
    }
  }
  return violations;
}

const pagesFiles = walk(join(ROOT, "src/pages"));
const consoleFiles = walk(join(ROOT, "src/console"));

const publicPagesImportingConsole = findForbiddenImports(pagesFiles, "/console/", (f) =>
  relative(ROOT, f).startsWith(join("src", "pages", "console")),
);

const consoleImportingPages = findForbiddenImports(consoleFiles, "/pages/", () => false);

const violations = [...publicPagesImportingConsole, ...consoleImportingPages];

if (violations.length > 0) {
  console.error("✗ console/public isolation violated:");
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}

console.log("✓ console isolation: no public page imports src/console/**, and src/console/** imports nothing from src/pages/**");
