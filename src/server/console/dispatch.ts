import { and, gte, eq } from "drizzle-orm";
import type { AppDb } from "../../../db/client.ts";
import { runs } from "../../../db/schema.ts";
import type { KvLike } from "../../lib/drivers/cache-kv.ts";
import { isPipelineEnabled } from "./killswitch.ts";

const DISPATCH_STAGE = "dispatch";
const MAX_DISPATCHES_PER_HOUR = 10;

export type DispatchResult =
  | { kind: "queued"; runId: string; note: string }
  | { kind: "disabled" }
  | { kind: "rate_limited" };

/**
 * `POST /console/dispatch` — ARCHITECTURE.md §6: "trigger a pipeline run ad
 * hoc", session + rate limited to 10/hour. The actual WATCH→...→EXPORT
 * runner lives in GitHub Actions (ARCHITECTURE.md §0) and there is no
 * `workflow_dispatch` credential provisioned yet (PROVISIONED.md lists
 * none) — so this records a real, auditable `runs` row honestly, rather
 * than fabricating a triggered run, and says so in `note` instead of
 * silently no-opping.
 */
export async function dispatchRun(db: AppDb, killswitchKv: KvLike, now: () => number = Date.now): Promise<DispatchResult> {
  if (!(await isPipelineEnabled(killswitchKv))) {
    // CONSOLE_SPEC.md §6 acceptance test 6: killswitch-on "exits before the
    // first Groq call, and says so in runs" — recorded here even though
    // dispatchRun itself never calls Groq, so the same observable trail
    // exists regardless of which stage actually halts on the killswitch.
    const runId = crypto.randomUUID();
    await db
      .insert(runs)
      .values({ id: runId, startedAt: new Date(now()).toISOString(), stage: DISPATCH_STAGE, status: "skipped", errorClass: "pipeline_disabled", traceId: runId })
      .run();
    return { kind: "disabled" };
  }

  const oneHourAgoIso = new Date(now() - 60 * 60 * 1000).toISOString();
  const recent = await db
    .select()
    .from(runs)
    .where(and(eq(runs.stage, DISPATCH_STAGE), gte(runs.startedAt, oneHourAgoIso)))
    .all();
  if (recent.length >= MAX_DISPATCHES_PER_HOUR) return { kind: "rate_limited" };

  const runId = crypto.randomUUID();
  await db
    .insert(runs)
    .values({
      id: runId,
      startedAt: new Date(now()).toISOString(),
      stage: DISPATCH_STAGE,
      status: "queued",
      traceId: runId,
    })
    .run();

  return {
    kind: "queued",
    runId,
    note: "recorded — no GitHub Actions workflow_dispatch credential is provisioned yet (PROVISIONED.md), so the pipeline run itself was not actually triggered",
  };
}
