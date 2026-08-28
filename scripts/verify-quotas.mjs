#!/usr/bin/env node
// Warns (never fails) if the hard-coded quota constants in
// src/config/quotas.ts have drifted from the numbers documented in
// ARCHITECTURE.md §0/§9. This is a docs-vs-code drift check, not a live
// call against provider pricing pages — those pages change shape too often
// to scrape reliably, and a stale scrape would be worse than none.
// See AGENT_PLAYBOOK.md Phase 0 Task 0.3, item 10.

import { readFileSync } from "node:fs";

function parseAmount(text) {
  const match = text.match(/([\d,.]+)\s*([kKmM])?/);
  if (!match) return null;
  const base = Number(match[1].replace(/,/g, ""));
  const unit = match[2]?.toLowerCase();
  if (unit === "k") return base * 1_000;
  if (unit === "m") return base * 1_000_000;
  return base;
}

function extract(doc, label, pattern) {
  const match = doc.match(pattern);
  if (!match) {
    return { label, found: false, value: null };
  }
  return { label, found: true, value: parseAmount(match[1]) };
}

async function main() {
  const { QUOTAS } = await import("../src/config/quotas.ts");
  const doc = readFileSync("ARCHITECTURE.md", "utf8");

  const checks = [
    [extract(doc, "groq.requestsPerMinute", /~([\d.]+)\s*req\/min/), QUOTAS.groq.requestsPerMinute],
    [extract(doc, "groq.tokensPerMinute", /~([\d.]+k?)\s*tokens\/min/), QUOTAS.groq.tokensPerMinute],
    [extract(doc, "groq.requestsPerDay", /~([\d.]+k?)\s*req\/day/), QUOTAS.groq.requestsPerDay],
    [
      extract(doc, "githubActions.minutesPerMonthPrivate", /([\d,]+)\s*min\/mo private/),
      QUOTAS.githubActions.minutesPerMonthPrivate,
    ],
    [extract(doc, "cloudflareD1.storageGb", /Cloudflare D1\*\* \| ([\d,]+)\s*GB/), QUOTAS.cloudflareD1.storageGb],
    [
      extract(doc, "cloudflareD1.rowReadsPerDay", /([\d,]+[kKmM]?)\s*row-reads\/day/),
      QUOTAS.cloudflareD1.rowReadsPerDay,
    ],
    [extract(doc, "cloudflareKv.storageGb", /Cloudflare KV\*\* \| ([\d,]+)\s*GB/), QUOTAS.cloudflareKv.storageGb],
    [extract(doc, "cloudflareKv.readsPerDay", /([\d,]+[kKmM]?)\s*reads\/day/), QUOTAS.cloudflareKv.readsPerDay],
    [extract(doc, "cloudflareKv.writesPerDay", /([\d,]+[kKmM]?)\s*writes\/day/), QUOTAS.cloudflareKv.writesPerDay],
  ];

  let driftCount = 0;

  for (const [result, expected] of checks) {
    if (!result.found) {
      console.warn(`⚠ could not find "${result.label}" in ARCHITECTURE.md — check the regex still matches`);
      driftCount++;
      continue;
    }
    if (result.value !== expected) {
      console.warn(
        `⚠ ${result.label}: src/config/quotas.ts says ${expected}, ARCHITECTURE.md says ${result.value}`,
      );
      driftCount++;
    }
  }

  if (driftCount === 0) {
    console.log("verify-quotas: constants match ARCHITECTURE.md.");
  } else {
    console.warn(`verify-quotas: ${driftCount} drift warning(s) — not failing the build.`);
  }
}

main();
