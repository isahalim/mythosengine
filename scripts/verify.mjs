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
  ["console/public bundle isolation", "node", ["scripts/check-console-isolation.mjs"]],
  ["build", "npx", ["astro", "build"]],
  ["test + coverage (80% on src/lib/**)", "npx", ["vitest", "run", "--coverage"]],
  ["size-limit", "npx", ["size-limit"]],
  ["scan dist/ for secrets", "node", ["scripts/scan-bundle-for-secrets.mjs"]],
];

const PENDING = [];

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
// Through tsx, not bare node: the script dynamically imports
// src/config/quotas.ts, and node cannot load a .ts file. Under plain node
// this step threw ERR_UNKNOWN_FILE_EXTENSION on every run — and because it
// is warn-only, nothing noticed, so the quota-drift check had never actually
// run. Fixed 2026-09-01 while changing those constants.
spawnSync("npx", ["tsx", "scripts/verify-quotas.mjs"], { stdio: "inherit" });

if (PENDING.length > 0) {
  console.log("\n--- pending, not yet enforceable (see reasons) ---");
  for (const line of PENDING) console.log(`  - ${line}`);
}

console.log("\npnpm verify: all checks passed.");
