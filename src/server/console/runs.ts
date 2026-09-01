import { desc, eq, inArray } from "drizzle-orm";
import type { AppDb } from "../../../db/client.ts";
import { exports as exportsTable, renders, runs, scripts } from "../../../db/schema.ts";
import { extractKeywords } from "../../lib/pipeline/keywords.ts";
import { DISPATCH_NOT_TRIGGERED_NOTE, DISPATCH_STAGE } from "./dispatch.ts";
import type { ExportStatus } from "./exports.ts";

/**
 * The guided run's data source (plan v2 §7 steps 4 and 5).
 *
 * A "run", to the console, is one `runs.trace_id`: the pipeline opens a row
 * per stage and stamps all of them with the same trace (db/runs.ts), so the
 * trace is the only identifier that spans a whole invocation. Everything
 * that invocation produced hangs off `scripts.trace_id` (added
 * 2026-08-31) — script → render → export, by the foreign keys that already
 * existed.
 *
 * Every field below is read from a row. Nothing here interpolates a
 * percentage, estimates a finish time, or reports a stage the pipeline has
 * not actually recorded: the waiting screen shows what is true, including
 * "this run was recorded but never triggered", which is the honest state of
 * a dispatch made without a workflow_dispatch credential.
 */

interface RunStage {
  stage: string;
  /** As recorded: "running" | "succeeded" | "failed" | "skipped" | "queued". Not narrowed — `runs.status` is a free text column and a new stage writer must not break this read. */
  status: string;
  startedAt: string;
  finishedAt: string | null;
  errorClass: string | null;
}

interface RunVideo {
  scriptId: string;
  hook: string;
  /** Visual keywords for the montage, derived from the script itself (src/lib/pipeline/keywords.ts). Empty until SCRIPT has written a row. */
  keywords: string[];
  wordCount: number;
  createdAt: string;
  renderId: string | null;
  renderStatus: string | null;
  ttsVoice: string | null;
  durationS: number | null;
  exportId: string | null;
  exportStatus: ExportStatus | null;
  suggestedTitle: string | null;
  sizeBytes: number | null;
}

type RunStatus = "not_triggered" | "queued" | "running" | "succeeded" | "failed";

export interface RunProgress {
  traceId: string;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  stages: RunStage[];
  videos: RunVideo[];
  /** Set only when there is something the operator must be told about the run as a whole — currently the never-triggered dispatch. */
  note: string | null;
}

export interface RunSummary {
  traceId: string;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  videoCount: number;
}

/** How many `runs` rows one listing reads. A RENDER invocation writes at most seven (one per stage in scripts/pipeline/render.ts), so this covers a comfortable few dozen runs. */
const RUN_ROW_SCAN_LIMIT = 300;

/**
 * The console's dispatch record is not one of the run's stages, and folding
 * it into the aggregate gets the answer wrong at both ends.
 *
 * Its own status carries exactly one fact — what happened to the
 * `workflow_dispatch` POST (src/server/console/dispatch.ts):
 *
 *   queued      recorded, nothing was triggered (no credential)
 *   succeeded   GitHub accepted the dispatch; the run has not reported yet
 *   failed      the dispatch attempt itself failed
 *   skipped     the killswitch was off
 *
 * Read as a stage instead, a `succeeded` dispatch made a run with no videos
 * look finished, and leaving it `running` would have made every completed
 * run look like it was still working forever. So the pipeline's own rows
 * decide the run's status, and the dispatch row only speaks when there are
 * none of them yet.
 */
function statusOf(stageRows: RunStage[]): RunStatus {
  const pipeline = stageRows.filter((row) => row.stage !== DISPATCH_STAGE);
  const dispatch = stageRows.find((row) => row.stage === DISPATCH_STAGE) ?? null;

  if (pipeline.length === 0) {
    // Nothing has reported from the runner. What that means depends
    // entirely on whether a workflow was actually started — reporting a
    // never-triggered run as "queued" would leave the waiting screen
    // spinning on a run that is never coming, which is the
    // fabricated-status failure db/runs.ts's reaper exists to stop,
    // arriving from the other end.
    if (dispatch === null) return "queued";
    if (dispatch.status === "queued") return "not_triggered";
    if (dispatch.status === "failed") return "failed";
    // Dispatched, and genuinely waiting: a run can sit in GitHub's queue
    // for as long as the self-hosted runner is offline.
    return "queued";
  }

  if (pipeline.some((row) => row.status === "running")) return "running";
  if (pipeline.some((row) => row.status === "failed")) return "failed";
  if (pipeline.some((row) => row.status === "queued")) return "queued";
  return "succeeded";
}

function toStage(row: typeof runs.$inferSelect): RunStage {
  return { stage: row.stage, status: row.status, startedAt: row.startedAt, finishedAt: row.finishedAt, errorClass: row.errorClass };
}

/**
 * The videos one trace produced, with each one's render and export attached.
 *
 * Three queries and two in-memory maps, not a join: drizzle's join over the
 * D1 HTTP client returns corrupted rows whenever two tables share a column
 * name, and `scripts`, `renders` and `exports` all have `id` (CLAUDE.md's
 * NEVER block; confirmed against the live database 2026-08-31).
 */
async function videosForTrace(db: AppDb, traceId: string): Promise<RunVideo[]> {
  const scriptRows = await db.select().from(scripts).where(eq(scripts.traceId, traceId)).all();
  if (scriptRows.length === 0) return [];

  const renderRows = await db
    .select()
    .from(renders)
    .where(inArray(renders.scriptId, scriptRows.map((row) => row.id)))
    .all();
  const exportRows =
    renderRows.length === 0
      ? []
      : await db
          .select()
          .from(exportsTable)
          .where(inArray(exportsTable.renderId, renderRows.map((row) => row.id)))
          .all();

  const renderByScriptId = new Map(renderRows.map((row) => [row.scriptId, row]));
  const exportByRenderId = new Map(exportRows.map((row) => [row.renderId, row]));

  return scriptRows
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((script) => {
      const render = renderByScriptId.get(script.id);
      const exported = render ? exportByRenderId.get(render.id) : undefined;
      return {
        scriptId: script.id,
        hook: script.hook,
        keywords: extractKeywords({ hook: script.hook, body: script.body, debateQuestion: script.debateQuestion }),
        wordCount: script.wordCount,
        createdAt: script.createdAt,
        renderId: render?.id ?? null,
        renderStatus: render?.status ?? null,
        ttsVoice: render?.ttsVoice ?? null,
        durationS: render?.durationS ?? null,
        exportId: exported?.id ?? null,
        exportStatus: (exported?.status as ExportStatus | undefined) ?? null,
        suggestedTitle: exported?.suggestedTitle ?? null,
        sizeBytes: exported?.sizeBytes ?? null,
      };
    });
}

export async function getRunProgress(db: AppDb, traceId: string): Promise<RunProgress | null> {
  const rows = await db.select().from(runs).where(eq(runs.traceId, traceId)).all();
  if (rows.length === 0) return null;

  const stages = rows.map(toStage).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const status = statusOf(stages);
  const finishedAt = stages.every((stage) => stage.finishedAt !== null)
    ? stages.reduce<string | null>((latest, stage) => (latest === null || (stage.finishedAt ?? "") > latest ? stage.finishedAt : latest), null)
    : null;

  return {
    traceId,
    status,
    startedAt: stages[0].startedAt,
    finishedAt,
    stages,
    videos: await videosForTrace(db, traceId),
    note: status === "not_triggered" ? DISPATCH_NOT_TRIGGERED_NOTE : null,
  };
}

/** Recent runs, newest first — what the run page offers when the operator arrives without a run in hand. */
export async function listRecentRuns(db: AppDb, limit = 10): Promise<RunSummary[]> {
  const rows = await db.select().from(runs).orderBy(desc(runs.startedAt)).limit(RUN_ROW_SCAN_LIMIT).all();

  const byTrace = new Map<string, RunStage[]>();
  for (const row of rows) {
    const existing = byTrace.get(row.traceId);
    if (existing) existing.push(toStage(row));
    else byTrace.set(row.traceId, [toStage(row)]);
  }

  const traceIds = [...byTrace.keys()].slice(0, limit);
  const scriptRows =
    traceIds.length === 0 ? [] : await db.select().from(scripts).where(inArray(scripts.traceId, traceIds)).all();
  const videoCounts = new Map<string, number>();
  for (const script of scriptRows) {
    if (script.traceId === null) continue;
    videoCounts.set(script.traceId, (videoCounts.get(script.traceId) ?? 0) + 1);
  }

  return traceIds.map((traceId) => {
    const stages = (byTrace.get(traceId) ?? []).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    return {
      traceId,
      status: statusOf(stages),
      startedAt: stages[0].startedAt,
      finishedAt: stages.every((stage) => stage.finishedAt !== null) ? stages[stages.length - 1].finishedAt : null,
      videoCount: videoCounts.get(traceId) ?? 0,
    };
  });
}
