import { and, gte, eq } from "drizzle-orm";
import type { AppDb } from "../../../db/client.ts";
import { listQueuedPicks } from "../../../db/run-picks.ts";
import { runs } from "../../../db/schema.ts";
import type { KvLike } from "../../lib/drivers/cache-kv.ts";
import type { GithubActionsDriver } from "../../lib/drivers/github-actions.ts";
import { isPipelineEnabled } from "./killswitch.ts";

/** The stage name of the console's own dispatch record — read back by src/server/console/runs.ts to tell a recorded run from a triggered one. */
export const DISPATCH_STAGE = "dispatch";
const MAX_DISPATCHES_PER_HOUR = 10;

/** The workflow the console starts, and the ref it runs from. Defaults; overridable per deployment through RouterEnv. */
export const DEFAULT_RENDER_WORKFLOW = "render.yml";
export const DEFAULT_RENDER_REF = "main";

/**
 * Said to the operator verbatim, in the console's run view as well as in the
 * dispatch response — the run page has to explain why a run it just created
 * will never move, and a second wording of the same fact would drift from
 * this one.
 */
export const DISPATCH_NOT_TRIGGERED_NOTE =
  "recorded — no GitHub Actions workflow_dispatch credential is provisioned yet (PROVISIONED.md), so the pipeline run itself was not actually triggered";

export type DispatchResult =
  | { kind: "queued"; runId: string; note: string | null }
  | { kind: "disabled" }
  | { kind: "rate_limited" };

export interface DispatchOptions {
  /** Null when no `GITHUB_DISPATCH_TOKEN` is configured — a real state, reported rather than hidden. */
  actions?: GithubActionsDriver | null;
  workflow?: string;
  ref?: string;
  now?: () => number;
}

/**
 * `POST /console/dispatch` — ARCHITECTURE.md §6: "trigger a pipeline run ad
 * hoc", session + rate limited to 10/hour. The actual RESEARCH→…→EXPORT
 * runner lives in GitHub Actions (ARCHITECTURE.md §0), because a Worker
 * cannot run FFmpeg, so starting a run means one `workflow_dispatch` POST.
 *
 * THE TRACE IS DECIDED HERE, and that is the load-bearing part. The `runs`
 * row this writes gets an id, and that same id is handed to the workflow as
 * its `trace_id` input, which `scripts/pipeline/render.ts` adopts instead of
 * minting its own. Before this, the console stamped one trace and the
 * pipeline stamped another, so stage 5 polled a trace the run would never
 * write to and sat on "waiting for the first script" forever even when the
 * run had finished. GitHub's dispatch endpoint returns no run id, so the
 * identifier has to travel downward — there is nothing to read back.
 *
 * With no credential configured this still records a real, auditable row and
 * says outright in `note` that nothing was triggered, rather than
 * fabricating a started run or silently no-opping.
 */
export async function dispatchRun(db: AppDb, killswitchKv: KvLike, options: DispatchOptions = {}): Promise<DispatchResult> {
  const { actions = null, workflow = DEFAULT_RENDER_WORKFLOW, ref = DEFAULT_RENDER_REF, now = Date.now } = options;

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
  const startedAt = new Date(now()).toISOString();
  // `queued` is the honest resting state of a dispatch record that has not
  // (yet) started anything, and src/server/console/runs.ts reads exactly
  // that to report `not_triggered`. It is promoted below once a workflow
  // really has been started.
  await db.insert(runs).values({ id: runId, startedAt, stage: DISPATCH_STAGE, status: "queued", traceId: runId }).run();

  if (actions === null) return { kind: "queued", runId, note: DISPATCH_NOT_TRIGGERED_NOTE };

  /**
   * How many videos this run should make: exactly the picks the operator
   * queued and nothing has claimed yet. The workflow renders one signal per
   * invocation, so it needs to be told how many times to invoke.
   *
   * Read here rather than in the workflow because the workflow cannot see
   * the queue before it starts, and a run that discovered mid-job that it
   * had five videos to make would have already sized its own timeout for
   * one. A zero count still dispatches: RENDER falls back to the diversity
   * weighting when the queue is empty, which is the ordinary scheduled
   * behaviour and not an error to refuse.
   */
  const queued = (await listQueuedPicks(db)).length;
  const count = Math.max(queued, 1);

  const triggered = await actions.dispatchWorkflow({ workflow, ref, inputs: { trace_id: runId, count: String(count) } });
  const finishedAt = new Date(now()).toISOString();

  if (!triggered.ok) {
    // The row stays — it is a true record that the operator asked for a
    // run — and it is closed as `failed` with the driver's own error text,
    // because "GitHub answered 403" and "the network timed out" call for
    // different fixes and the operator has to be able to tell them apart.
    await db
      .update(runs)
      .set({ status: "failed", finishedAt, errorClass: `dispatch_failed:${triggered.error.kind}` })
      .where(eq(runs.id, runId))
      .run();
    return {
      kind: "queued",
      runId,
      note: `recorded, but the GitHub Actions workflow could not be started (${triggered.error.kind}: ${triggered.error.message})`,
    };
  }

  // The DISPATCH stage succeeded — the POST was accepted. It says nothing
  // about the run, which has not started yet and may sit in GitHub's queue
  // until the self-hosted runner comes online. runs.ts reads the pipeline's
  // own stages for that, and a dispatch row closed here is deliberately not
  // left `running`: db/runs.ts's reaper would eventually mark it abandoned.
  await db.update(runs).set({ status: "succeeded", finishedAt }).where(eq(runs.id, runId)).run();
  return { kind: "queued", runId, note: null };
}
