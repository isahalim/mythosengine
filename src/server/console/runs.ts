import { desc, eq, inArray } from "drizzle-orm";
import type { AppDb } from "../../../db/client.ts";
import { exports as exportsTable, renders, runs, scripts } from "../../../db/schema.ts";
import { PIPELINE_STAGE } from "../../../db/runs.ts";
import { extractKeywords } from "../../lib/pipeline/keywords.ts";
import { shotsForScripts } from "../../../db/shot-plans.ts";
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
  /** As recorded: "running" | "succeeded" | "failed" | "degraded" | "skipped" | "queued". Not narrowed — `runs.status` is a free text column and a new stage writer must not break this read. */
  status: string;
  startedAt: string;
  finishedAt: string | null;
  errorClass: string | null;
}

interface RunVideo {
  scriptId: string;
  hook: string;
  /** Visual keywords for the preview montage, derived from the script itself (src/lib/pipeline/keywords.ts). Empty until SCRIPT has written a row. */
  keywords: string[];
  /**
   * The shot plan and how far each shot has got — what stage 5 shows as the
   * sourcing process (db/shot-plans.ts).
   *
   * Every entry is a row PLAN wrote and SOURCE advanced. Nothing here is
   * predicted: a shot reads `searching` only once the search has been made,
   * `clipped` only once a clip exists with a provenance row behind it. Empty
   * until PLAN has run, which is the honest state before it has.
   */
  shots: RunShot[];
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

/** One planned shot, as the waiting screen shows it. */
interface RunShot {
  position: number;
  /** The beat this shot covers; null for the opening image over the hook. */
  beatIndex: number | null;
  /** One sentence from PLAN: what this image is doing for this beat. */
  intent: string;
  /** What was typed into the search box — why this shot is in this video. */
  query: string;
  source: "youtube" | "pexels";
  status: "planned" | "searching" | "downloading" | "clipped" | "composited" | "failed";
  /** Why this shot did not make it. Null unless it failed. */
  error: string | null;
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

/** How many `runs` rows one listing reads. A RENDER invocation writes at most nine (one per stage in scripts/pipeline/render.ts, plus the invocation's own `pipeline` row), so this covers a comfortable few dozen runs. */
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
  const lifecycle = stageRows.filter((row) => row.stage === PIPELINE_STAGE);
  const pipeline = stageRows.filter((row) => row.stage !== DISPATCH_STAGE && row.stage !== PIPELINE_STAGE);
  const dispatch = stageRows.find((row) => row.stage === DISPATCH_STAGE) ?? null;

  /**
   * The invocation's own row is asked first, and it is the only row that can
   * answer this: a stage row says what is true while a stage is open, and
   * *between* two stages every row a live run has written is closed. That
   * gap read as "succeeded" here, so stage 4 stopped polling on
   * `EDIT · SUCCEEDED`, `0 / 1 exported` and never moved again, while the
   * render went on to export two minutes later (2026-09-03). A run with an
   * open lifecycle row is running, whatever its stages currently say.
   *
   * Absent on a trace written by a runner from before this row existed, and
   * the stage-only reading below is then still the best available answer —
   * which is what the fallbacks after this are.
   */
  if (lifecycle.some((row) => row.status === "running")) return "running";
  // A throw between two stages closes none of them: `PLAN produced no
  // shots` closes PLAN as succeeded and then fails the render, and every
  // stage row agrees it was a clean run. The lifecycle row is the one that
  // caught the throw, so it outranks them.
  if (lifecycle.some((row) => row.status === "failed")) return "failed";

  if (pipeline.length === 0) {
    // The invocation ran and made nothing — killswitch off, or WATCH has
    // scored nothing yet (`skipped`, from renderOneVideo). It is over, and
    // reporting it as queued would leave the screen waiting on a run that
    // has already finished.
    if (lifecycle.length > 0) return "succeeded";
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
  // `degraded` is deliberately not counted here: a stage allowed to fail
  // without costing the video (RESEARCH, PLAN, ALIGN, EDIT, HOST, CRITIC)
  // closes its row that way, and a run that shipped a video is not a failed
  // run. The stage row keeps its `errorClass`, so stage 4 still shows what
  // degraded and why — see `RunStageStatus` in db/runs.ts.
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

  // One query for the whole run's shots, grouped in memory — same reason as
  // the maps above, and a run is at most six videos of at most eight shots.
  const shotRows = await shotsForScripts(db, scriptRows.map((row) => row.id));
  const shotsByScriptId = new Map<string, RunShot[]>();
  for (const row of shotRows) {
    const list = shotsByScriptId.get(row.scriptId) ?? [];
    list.push({ position: row.position, beatIndex: row.beatIndex, intent: row.intent, query: row.query, source: row.source, status: row.status, error: row.error });
    shotsByScriptId.set(row.scriptId, list);
  }

  return scriptRows
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((script) => {
      const render = renderByScriptId.get(script.id);
      const exported = render ? exportByRenderId.get(render.id) : undefined;
      return {
        scriptId: script.id,
        hook: script.hook,
        keywords: extractKeywords({ hook: script.hook, body: script.body, debateQuestion: script.debateQuestion }),
        shots: shotsByScriptId.get(script.id) ?? [],
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
