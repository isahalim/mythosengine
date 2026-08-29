#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { finishRun, reapStaleRuns, startRun } from "../../db/runs.ts";
import { isPipelineEnabled } from "../../src/server/console/killswitch.ts";
import { watchAllEnabledSources } from "../../src/lib/ingest/watch.ts";
import { scoreObservedSignals } from "../../src/lib/ingest/score.ts";
import { seedSourcesFromYaml } from "../../src/lib/ingest/seed-sources.ts";
import { buildPipelineEnv } from "./env.ts";

const SOURCES_YAML_PATH = join(import.meta.dirname, "..", "..", "data", "sources.yml");

/**
 * WATCH + SCORE (ARCHITECTURE.md §5.1/§5.2), hourly cron
 * (.github/workflows/watch.yml). Runs from GitHub Actions, not the Worker —
 * see ARCHITECTURE.md §0 for why. Checks the console's killswitch first: a
 * scheduled run that ignored it would make "halt everything immediately"
 * a lie for anything except ad hoc dispatches.
 */
async function main(): Promise<void> {
  const env = buildPipelineEnv();

  if (!(await isPipelineEnabled(env.hotKv))) {
    console.warn("Pipeline killswitch is off — skipping this WATCH run.");
    return;
  }

  // Seed before polling, every run. data/sources.yml is the committed source
  // of truth for what WATCH monitors; this makes the table follow the file
  // instead of depending on someone having run a seeding command once.
  // Production's `sources` table was empty until 2026-08-29 for exactly that
  // reason — seedSourcesFromYaml existed and was unit-tested, but nothing
  // ever called it, so WATCH polled zero sources and reported no error
  // because there was genuinely nothing to poll. Idempotent, so a run with
  // nothing to add is a single read.
  const seeded = await seedSourcesFromYaml(env.db, env.rawClient, await readFile(SOURCES_YAML_PATH, "utf8"));
  if (seeded.inserted > 0) console.warn(`SEED: ${seeded.inserted} new source(s) added from data/sources.yml.`);

  // A previous run killed by the Actions job timeout leaves its row
  // `running` forever, which the console then reports as a live stage.
  // Swept here rather than in the console: this is a write, and the
  // pipeline owns the runs table.
  const reaped = await reapStaleRuns(env.db);
  if (reaped > 0) console.warn(`Reaped ${reaped} abandoned run row(s) left behind by a killed job.`);

  const traceId = crypto.randomUUID();

  const watchRunId = await startRun(env.db, "watch", traceId);
  try {
    const results = await watchAllEnabledSources(env.db);
    const failed = results.filter((r) => r.status === "failed");
    await finishRun(env.db, watchRunId, failed.length === results.length && results.length > 0 ? "failed" : "succeeded");
    console.warn(`WATCH: ${results.length} sources polled, ${failed.length} failed, ${results.reduce((sum, r) => sum + r.itemsObserved, 0)} signals observed.`);
  } catch (cause) {
    await finishRun(env.db, watchRunId, "failed", cause instanceof Error ? cause.message : String(cause));
    throw cause;
  }

  const scoreRunId = await startRun(env.db, "score", traceId);
  try {
    const result = await scoreObservedSignals(env.db);
    await finishRun(env.db, scoreRunId, "succeeded");
    console.warn(`SCORE: ${result.scored} scored, ${result.rejectedAsDuplicate} rejected as duplicate, ${result.rejectedAsFuture} rejected as future-dated.`);
  } catch (cause) {
    await finishRun(env.db, scoreRunId, "failed", cause instanceof Error ? cause.message : String(cause));
    throw cause;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
