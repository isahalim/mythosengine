import { and, eq, inArray, sql } from "drizzle-orm";
import { execAtomic, type AppDb, type RawSqlClient } from "./client.ts";
import { runPicks, signals } from "./schema.ts";

/**
 * The operator's run plan, from both ends: the console queues picks
 * (plan v2 §7 steps 1-3) and RENDER claims them (scripts/pipeline/render.ts).
 *
 * Both ends live here rather than in `src/server/console/**` because the
 * pipeline runner has no access to the Worker's console modules — the same
 * split `db/runs.ts` and `db/footage-select.ts` already have.
 */

export interface QueuedPick {
  id: string;
  planId: string;
  position: number;
  topic: string;
  signalId: string;
  status: "queued" | "claimed" | "cancelled";
  claimedTraceId: string | null;
  createdAt: string;
}

export interface NewPick {
  topic: string;
  signalId: string;
}

/**
 * Writes one plan's picks as a single atomic batch — a half-written plan
 * would give the operator a run that silently drops the videos whose insert
 * failed (CLAUDE.md: never a multi-step mutation outside a transaction).
 *
 * Returns the plan id. Position is the array order, which is the order the
 * operator chose them in and the order RENDER will claim them.
 */
export async function queueRunPlan(rawClient: RawSqlClient, picks: NewPick[], now: () => number = Date.now): Promise<string> {
  const planId = crypto.randomUUID();
  const nowIso = new Date(now()).toISOString();

  await execAtomic(
    rawClient,
    picks.map((pick, index) => ({
      sql: `INSERT INTO run_picks (id, plan_id, position, topic, signal_id, status, created_at) VALUES (?, ?, ?, ?, ?, 'queued', ?)`,
      params: [crypto.randomUUID(), planId, index, pick.topic, pick.signalId, nowIso],
    })),
  );

  return planId;
}

/**
 * Claims the next queued pick for one pipeline invocation, atomically.
 *
 * One `UPDATE ... RETURNING` with a correlated subquery, the same shape (and
 * for the same reason) as db/footage-select.ts's `claimNextFootageSegment`:
 * a read-then-write would leave a window where two concurrent RENDER jobs
 * both see the same queued pick and both render it. The subquery also
 * re-checks the signal's state inside the same statement — a pick whose
 * signal has already been scripted by an earlier run must not be claimable,
 * and checking that separately would reopen the window it closes.
 *
 * Returns null when the queue is empty, which is the ordinary case: a
 * scheduled RENDER with no operator plan behind it falls back to its own
 * diversity-weighted choice.
 */
export async function claimNextRunPick(db: AppDb, traceId: string, nowIso: string): Promise<QueuedPick | null> {
  const rows = await db
    .update(runPicks)
    .set({ status: "claimed", claimedTraceId: traceId, claimedAt: nowIso })
    .where(
      sql`${runPicks.id} = (
        SELECT p.id FROM run_picks p
        JOIN signals s ON s.id = p.signal_id
        WHERE p.status = 'queued' AND s.state = 'scored'
        ORDER BY p.created_at ASC, p.position ASC
        LIMIT 1
      )`,
    )
    .returning()
    .all();

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    planId: row.planId,
    position: row.position,
    topic: row.topic,
    signalId: row.signalId,
    status: "claimed",
    claimedTraceId: traceId,
    createdAt: row.createdAt,
  };
}

/** Everything still waiting to be rendered, in claim order — what the run view shows as "queued". */
export async function listQueuedPicks(db: AppDb): Promise<QueuedPick[]> {
  const rows = await db.select().from(runPicks).where(eq(runPicks.status, "queued")).all();
  return rows
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.position - b.position)
    .map((row) => ({
      id: row.id,
      planId: row.planId,
      position: row.position,
      topic: row.topic,
      signalId: row.signalId,
      status: "queued" as const,
      claimedTraceId: row.claimedTraceId,
      createdAt: row.createdAt,
    }));
}

/**
 * Cancels a queued pick. Deliberately scoped to `status = 'queued'`: a pick
 * a render has already claimed is being worked on right now, and marking it
 * cancelled would say something untrue about a video that is about to
 * appear. Returns whether a row actually changed.
 */
export async function cancelPick(db: AppDb, id: string): Promise<boolean> {
  const rows = await db
    .update(runPicks)
    .set({ status: "cancelled" })
    .where(and(eq(runPicks.id, id), eq(runPicks.status, "queued")))
    .returning()
    .all();
  return rows.length > 0;
}

/** The signals behind a set of picks, for a console view that needs their titles. */
export async function signalsForPicks(db: AppDb, picks: QueuedPick[]) {
  if (picks.length === 0) return [];
  return db
    .select()
    .from(signals)
    .where(inArray(signals.id, picks.map((pick) => pick.signalId)))
    .all();
}
