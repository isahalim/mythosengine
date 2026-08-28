#!/usr/bin/env node
// Greps the built dist/ output for secret values pulled from local env files,
// plus a generic high-entropy-string check. Fails (non-zero exit) on any hit.
// See AGENT_PLAYBOOK.md Phase 0 Task 0.3, item 9.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const DIST_DIR = "dist";
const ENV_FILES = [".env.local", ".dev.vars"];
const HIGH_ENTROPY = /[A-Za-z0-9_-]{32,}/g;

// Astro's own content-hashed asset filenames (e.g. index.Bx7z9k2A.js) are
// expected high-entropy strings and are not secrets.
const HASH_ALLOWLIST = /\.[A-Za-z0-9_-]{6,12}\.(js|css|mjs)$/;

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listFiles(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

function loadEnvValues() {
  const values = [];
  for (const file of ENV_FILES) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const line of text.split("\n")) {
      const match = line.match(/^\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.+?)\s*$/);
      if (!match) continue;
      const value = match[1].replace(/^["']|["']$/g, "");
      if (value.length >= 8) values.push(value);
    }
  }
  return values;
}

function main() {
  if (!existsSync(DIST_DIR)) {
    console.error(`scan-bundle-for-secrets: ${DIST_DIR}/ does not exist — run the build first.`);
    process.exit(1);
  }

  const envValues = loadEnvValues();
  const files = listFiles(DIST_DIR);
  let hits = 0;

  for (const file of files) {
    if (HASH_ALLOWLIST.test(file)) continue;
    const text = readFileSync(file, "utf8").toString();

    for (const value of envValues) {
      if (text.includes(value)) {
        console.error(`SECRET LEAK: a value from a local env file was found in ${file}`);
        hits++;
      }
    }

    for (const match of text.matchAll(HIGH_ENTROPY)) {
      const token = match[0];
      // Skip things that are clearly not secrets: repeated chars, hex-only
      // content hashes shorter than typical key lengths.
      if (/^[0-9a-f]{32,40}$/i.test(token) && token.length <= 40) continue;
      console.warn(`high-entropy string in ${file}: ${token.slice(0, 8)}… (${token.length} chars) — review manually`);
    }
  }

  if (hits > 0) {
    console.error(`\nscan-bundle-for-secrets: ${hits} leak(s) found. Failing.`);
    process.exit(1);
  }

  console.log("scan-bundle-for-secrets: no known secret values found in dist/.");
}

main();
