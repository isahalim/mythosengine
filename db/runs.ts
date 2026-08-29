import { eq } from "drizzle-orm";
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

export async function finishRun(db: AppDb, runId: string, status: "succeeded" | "failed" | "skipped", errorClass?: string, now: () => number = Date.now): Promise<void> {
  await db
    .update(runs)
    .set({ finishedAt: new Date(now()).toISOString(), status, errorClass: errorClass ?? null })
    .where(eq(runs.id, runId))
    .run();
}
