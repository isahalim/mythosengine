#!/usr/bin/env node
// The single verification command (CLAUDE.md: "Never mark work complete
// without running pnpm verify"). Order and steps follow AGENT_PLAYBOOK.md
// Phase 0 Task 0.3. `build` is not one of the ten listed items but runs
// before the two steps that need dist/ to exist.

import { spawnSync } from "node:child_process";

const steps = [
  ["typecheck", "npx", ["tsc", "--noEmit"]],
  ["lint", "npx", ["eslint", ".", "--max-warnings", "0"]],
  ["gitleaks (working tree)", "gitleaks", ["detect", "--no-git", "--redact", "--no-banner"]],
  ["gitleaks (full history)", "gitleaks", ["detect", "--redact", "--no-banner"]],
  ["semgrep", "semgrep", ["--config=p/owasp-top-ten", "--config=p/typescript", "--error", "--quiet"]],
  ["osv-scanner", "osv-scanner", ["-r", "."]],
  ["pnpm audit", "pnpm", ["audit", "--audit-level=high"]],
  ["knip", "npx", ["knip"]],
  ["build", "npx", ["astro", "build"]],
  ["test + coverage (80% on src/lib/**)", "npx", ["vitest", "run", "--coverage"]],
  ["size-limit", "npx", ["size-limit"]],
  ["scan dist/ for secrets", "node", ["scripts/scan-bundle-for-secrets.mjs"]],
];

const PENDING = [
  "size-limit JS budget for the hero island (≤60KB gzip) and per-route JS (≤120KB gzip) — " +
    "no hero/islands exist yet (Phase 7). Currently only the CSS bundle is budgeted.",
];

let failed = false;

for (const [label, cmd, args] of steps) {
  console.log(`\n▶ ${label}`);
  const result = spawnSync(cmd, args, { stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`✗ ${label} failed`);
    failed = true;
    break;
  }
  console.log(`✓ ${label}`);
}

if (failed) {
  process.exit(1);
}

console.log("\n▶ verify-quotas (warns, never fails)");
spawnSync("node", ["scripts/verify-quotas.mjs"], { stdio: "inherit" });

console.log("\n--- pending, not yet enforceable (see reasons) ---");
for (const line of PENDING) console.log(`  - ${line}`);

console.log("\npnpm verify: all checks passed.");
