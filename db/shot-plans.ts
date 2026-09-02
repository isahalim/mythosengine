import { and, asc, eq, inArray } from "drizzle-orm";
import { execAtomic, type AppDb, type RawSqlClient } from "./client.ts";
import { shotPlans } from "./schema.ts";

/**
 * The shot plan, from both ends: RENDER writes it and advances it, and the
 * console reads it for stage 5.
 *
 * Here rather than in `src/server/console/**` for the same reason
 * `db/runs.ts` and `db/run-picks.ts` are: the pipeline runner has no access
 * to the Worker's console modules, and both ends need these queries.
 */

export type ShotStatus = "planned" | "searching" | "downloading" | "clipped" | "composited" | "failed";

export interface ShotRow {
  id: string;
  scriptId: string;
  position: number;
  beatIndex: number | null;
  intent: string;
  query: string;
  source: "youtube" | "pexels";
  status: ShotStatus;
  footageSegmentId: string | null;
  error: string | null;
}

export interface NewShot {
  position: number;
  beatIndex: number | null;
  intent: string;
  query: string;
  source: "youtube" | "pexels";
  /** The host's action over this shot, or null when nothing chose one. */
  characterAction: string | null;
}

/**
 * Writes a whole plan as one atomic batch.
 *
 * A half-written plan would show the operator a run building four shots when
 * it is building seven, and stage 5's entire claim is that what it shows is
 * what the pipeline recorded (CLAUDE.md: never a multi-step mutation outside
 * a transaction).
 */
export async function saveShotPlan(rawClient: RawSqlClient, scriptId: string, traceId: string, shots: NewShot[], nowIso: string): Promise<void> {
  if (shots.length === 0) return;
  await execAtomic(
    rawClient,
    shots.map((shot) => ({
      sql: `INSERT INTO shot_plans (id, script_id, trace_id, position, beat_index, intent, query, source, character_action, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?)`,
      params: [crypto.randomUUID(), scriptId, traceId, shot.position, shot.beatIndex, shot.intent, shot.query, shot.source, shot.characterAction, nowIso, nowIso],
    })),
  );
}

/**
 * Moves one shot along.
 *
 * Scoped by script and position rather than by id, because the caller is the
 * sourcing agent and it knows a shot by where it sits in the plan, not by a
 * uuid it never saw.
 */
export async function advanceShot(
  db: AppDb,
  scriptId: string,
  position: number,
  status: ShotStatus,
  nowIso: string,
  extra: { footageSegmentId?: string; error?: string } = {},
): Promise<void> {
  await db
    .update(shotPlans)
    .set({
      status,
      updatedAt: nowIso,
      ...(extra.footageSegmentId === undefined ? {} : { footageSegmentId: extra.footageSegmentId }),
      // Cleared on any status that is not a failure, so a shot that failed
      // one candidate and succeeded on the next does not keep displaying
      // the reason it nearly did not.
      error: extra.error ?? null,
    })
    .where(and(eq(shotPlans.scriptId, scriptId), eq(shotPlans.position, position)))
    .run();
}

/** Statuses a shot can still move on from. Anything else is where it ended. */
const IN_FLIGHT: ShotStatus[] = ["planned", "searching", "downloading", "clipped"];

/**
 * Marks shots abandoned by a render that is no longer running.
 *
 * A killed render — Actions timeout, Ctrl-C, a laptop closing — leaves its
 * shot rows exactly where they were, and stage 5 then shows a shot as
 * `downloading` forever, for a run that stopped hours ago. That is the
 * fabricated-status failure `db/runs.ts`'s reaper and `releaseStrandedPicks`
 * both exist to prevent, arriving through the third door. Found in the shot
 * rows of a render killed mid-download on 2026-09-01.
 *
 * `liveTraceIds` is the traces still running AFTER the run reaper has
 * failed the abandoned ones, so this inherits that definition of "alive"
 * rather than inventing a second, shorter one.
 *
 * `clipped` counts as in-flight on purpose: it means the clip existed but
 * the render never reached the encoder, so the shot never made it into a
 * video and saying it did would be untrue.
 */
export async function reapAbandonedShots(db: AppDb, liveTraceIds: readonly string[], nowIso: string): Promise<number> {
  const rows = await db.select().from(shotPlans).where(inArray(shotPlans.status, IN_FLIGHT)).all();
  const live = new Set(liveTraceIds);
  const abandoned = rows.filter((row) => !live.has(row.traceId));
  if (abandoned.length === 0) return 0;

  await db
    .update(shotPlans)
    .set({ status: "failed", error: "abandoned: the render that was sourcing this shot stopped before it reached the encoder", updatedAt: nowIso })
    .where(inArray(shotPlans.id, abandoned.map((row) => row.id)))
    .run();
  return abandoned.length;
}

/** Every shot of every video in one run, in plan order. What stage 5 renders. */
export async function shotsForTrace(db: AppDb, traceId: string): Promise<ShotRow[]> {
  const rows = await db.select().from(shotPlans).where(eq(shotPlans.traceId, traceId)).orderBy(asc(shotPlans.position)).all();
  return rows.map(toShotRow);
}

/** One video's shots. */
export async function shotsForScripts(db: AppDb, scriptIds: string[]): Promise<ShotRow[]> {
  if (scriptIds.length === 0) return [];
  const rows = await db.select().from(shotPlans).where(inArray(shotPlans.scriptId, scriptIds)).all();
  return rows.sort((a, b) => a.scriptId.localeCompare(b.scriptId) || a.position - b.position).map(toShotRow);
}

function toShotRow(row: typeof shotPlans.$inferSelect): ShotRow {
  return {
    id: row.id,
    scriptId: row.scriptId,
    position: row.position,
    beatIndex: row.beatIndex,
    intent: row.intent,
    query: row.query,
    source: row.source,
    status: row.status,
    footageSegmentId: row.footageSegmentId,
    error: row.error,
  };
}
