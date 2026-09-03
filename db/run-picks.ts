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
 * operator chose them in and the order RENDER will claim them *within this
 * plan* — across plans it is the newest plan first (`claimNextRunPick`).
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
 * **Newest plan first, then the operator's own order inside it.** This was
 * `created_at ASC` — plain FIFO — and it made the wrong video. 2026-09-03,
 * in order: the operator picked a story at 20:14:44.438Z; the dispatch read
 * a queue holding only that pick 0.3s later and sized the run to one video;
 * the invocation started at 20:14:47Z, and its own `releaseStrandedPicks`
 * sweep requeued a pick from 07:02:30Z that morning, whose render had died
 * at SCRIPT. FIFO then handed the run the older one. The operator watched a
 * thirteen-hour-old story render in a run they had sized for the story they
 * had just chosen, which was never going to be made at all.
 *
 * That is not what a queue this shape is for. Every entry in it was chosen
 * by hand, seconds ago, from a list the operator was looking at — so the
 * newest ask is the one they are waiting for, and a leftover swept back onto
 * the queue *after the run was sized* is exactly the thing that must give
 * way to it. The leftover is not dropped: it stays queued, and the next
 * invocation that finds nothing newer claims it.
 *
 * `created_at` is stamped once per plan (`queueRunPlan` above), so a plan's
 * own picks tie on it and `position ASC` keeps them in the order the
 * operator built them.
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
        ORDER BY p.created_at DESC, p.position ASC
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

/**
 * Returns picks claimed by a run that is no longer alive.
 *
 * A render killed mid-flight — an Actions job timeout, a Ctrl-C, a laptop
 * closing — leaves its pick `claimed` forever, and the operator's queued
 * story silently never gets made. `reapStaleRuns` already does exactly this
 * for `runs` rows; picks had no equivalent, and the gap showed up the first
 * time a viral render was killed mid-download: the next run found an empty
 * queue, fell back to the diversity-weighted pick, and made a video about
 * something the operator had not chosen (2026-09-01).
 *
 * Scoped to picks whose signal is still `scored` — a pick whose story has
 * since been written is genuinely spent, and requeueing it would make a
 * second video about the same thing.
 */
export async function releaseStrandedPicks(db: AppDb, liveTraceIds: readonly string[]): Promise<number> {
  const claimed = await db.select().from(runPicks).where(eq(runPicks.status, "claimed")).all();
  const live = new Set(liveTraceIds);
  const stranded = claimed.filter((row) => row.claimedTraceId === null || !live.has(row.claimedTraceId));
  if (stranded.length === 0) return 0;

  const signalRows = await db.select().from(signals).where(inArray(signals.id, stranded.map((row) => row.signalId))).all();
  const stillScored = new Set(signalRows.filter((row) => row.state === "scored").map((row) => row.id));

  const requeueable = stranded.filter((row) => stillScored.has(row.signalId)).map((row) => row.id);
  if (requeueable.length === 0) return 0;

  await db
    .update(runPicks)
    .set({ status: "queued", claimedTraceId: null, claimedAt: null })
    .where(inArray(runPicks.id, requeueable))
    .run();
  return requeueable.length;
}

/**
 * Everything still waiting to be rendered, in claim order — what the run
 * view shows as "queued", and what the dispatch counts to size the run.
 *
 * The sort is `claimNextRunPick`'s, deliberately: this list is read as "what
 * gets made next", and a listing ordered differently from the claim would be
 * a lie about the very next video.
 */
export async function listQueuedPicks(db: AppDb): Promise<QueuedPick[]> {
  const rows = await db.select().from(runPicks).where(eq(runPicks.status, "queued")).all();
  return rows
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.position - b.position)
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
