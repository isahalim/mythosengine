#!/usr/bin/env node
import { finishRun, startRun } from "../../db/runs.ts";
import { isPipelineEnabled } from "../../src/server/console/killswitch.ts";
import { watchAllEnabledSources } from "../../src/lib/ingest/watch.ts";
import { scoreObservedSignals } from "../../src/lib/ingest/score.ts";
import { buildPipelineEnv } from "./env.ts";

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
