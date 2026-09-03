import { and, eq, lt } from "drizzle-orm";
import type { AppDb } from "./client.ts";
import { runs } from "./schema.ts";

/**
 * Per-stage run tracking for the pipeline orchestrator (scripts/pipeline/**).
 * Until this, the only writer to `runs` was `src/server/console/dispatch.ts`'s
 * single fire-and-forget insert with no completion update — not enough for
 * `src/server/alerts/rules.ts`'s consecutive-failure checks (built, tested,
 * "not invoked by anything yet") to see real data. `startRun`/`finishRun`
 * are the two ends of one row's lifecycle, called around every stage.
 */
export async function startRun(db: AppDb, stage: string, traceId: string, now: () => number = Date.now): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .insert(runs)
    .values({ id, startedAt: new Date(now()).toISOString(), stage, status: "running", traceId })
    .run();
  return id;
}

/**
 * How a stage row is closed.
 *
 * `degraded` is the one worth explaining. Several stages are contractually
 * allowed to fail without costing the video — RESEARCH, PLAN, ALIGN, EDIT,
 * HOST and CRITIC each say so in their own file and in ARCHITECTURE.md — and
 * every one of them closed its row as `failed`. `statusOf`
 * (src/server/console/runs.ts) reports a run as failed if *any* stage row is,
 * so a render that degraded exactly as designed, produced a video and
 * exported it told the operator "The run failed" on stage 4. That is the
 * fabricated-status failure this file's reaper exists to prevent, arriving
 * from the other direction: not a run reported as alive when it is dead, but
 * a finished video reported as a wreck.
 *
 * So `failed` now means what it says — the stage failed and took the render
 * with it — and `degraded` means the stage did not do its job and the render
 * carried on without it. Both still carry the reason in `error_class`, and
 * both are still visible; only the aggregate verdict changes.
 */
export type RunStageStatus = "succeeded" | "failed" | "degraded" | "skipped";

export async function finishRun(db: AppDb, runId: string, status: RunStageStatus, errorClass?: string, now: () => number = Date.now): Promise<void> {
  await db
    .update(runs)
    .set({ finishedAt: new Date(now()).toISOString(), status, errorClass: errorClass ?? null })
    .where(eq(runs.id, runId))
    .run();
}

/**
 * A run row is opened by `startRun` and closed by `finishRun`, but the
 * pipeline runs in GitHub Actions, where a job that exceeds its
 * `timeout-minutes` is killed outright — no exception, no `finally`, no
 * chance to close the row. That row then stays `running` forever.
 *
 * The consequence is not cosmetic. `getConsoleSummary` reports the most
 * recent `running` row as the pipeline's live stage, so after the
 * 2026-08-29 footage-refresh timeout the console showed "Refreshing footage
 * library" with a filled progress bar indefinitely, for a job that had been
 * dead for hours. That is precisely the fabricated-status failure
 * CLAUDE.md's NEVER block exists to prevent, arriving through stale data
 * rather than through invented data.
 *
 * So every pipeline entrypoint sweeps first: anything still `running` past
 * the longest plausible job lifetime was abandoned, and is recorded as
 * `failed` with a reason that says so rather than being silently deleted —
 * `runs` is the observability trail, and "this was killed" is a real,
 * useful outcome for src/server/alerts/rules.ts to see.
 */
export const STALE_RUN_THRESHOLD_MS = 45 * 60 * 1000; // > the longest job timeout (footage-refresh, 30 min)

export async function reapStaleRuns(db: AppDb, now: () => number = Date.now, thresholdMs: number = STALE_RUN_THRESHOLD_MS): Promise<number> {
  const cutoff = new Date(now() - thresholdMs).toISOString();
  const stale = await db
    .select()
    .from(runs)
    .where(and(eq(runs.status, "running"), lt(runs.startedAt, cutoff)))
    .all();
  if (stale.length === 0) return 0;

  await db
    .update(runs)
    .set({
      status: "failed",
      finishedAt: new Date(now()).toISOString(),
      errorClass: "abandoned: still running past the stale-run threshold (runner killed or job timed out)",
    })
    .where(and(eq(runs.status, "running"), lt(runs.startedAt, cutoff)))
    .run();

  return stale.length;
}
