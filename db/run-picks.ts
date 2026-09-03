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
 * **`planId` scopes the claim to one plan, and that is how the console
 * dispatches** (operator direction 2026-09-03): a run makes the plan the
 * operator submitted seconds before it started, or it makes nothing. No
 * key is ever spent on a story chosen in an earlier session — the caller
 * treats "no claimable pick" as an invocation with nothing to do, rather
 * than falling back to a weighted pick nobody asked for.
 *
 * Unscoped — a hand-triggered or scheduled run — it is **newest plan first,
 * then the operator's own order inside it.** This was
 * `created_at ASC` — plain FIFO — and it made the wrong video. 2026-09-03,
 * in order: the operator picked a story at 20:14:44.438Z; the dispatch read
 * a queue holding only that pick 0.3s later and sized the run to one video;
 * the invocation started at 20:14:47Z, and its own stranded-pick
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
export async function claimNextRunPick(db: AppDb, traceId: string, nowIso: string, planId: string | null = null): Promise<QueuedPick | null> {
  // Two statements rather than one with an `OR ? IS NULL` clause: the plan
  // filter changes which rows are even candidates, and a scoped claim that
  // silently matched an unscoped row because a bind slipped would be the
  // exact failure this whole change exists to prevent. Both keep the pick
  // inside a single UPDATE, which is the part that must be atomic.
  const candidate =
    planId === null
      ? sql`(
        SELECT p.id FROM run_picks p
        JOIN signals s ON s.id = p.signal_id
        WHERE p.status = 'queued' AND s.state = 'scored'
        ORDER BY p.created_at DESC, p.position ASC
        LIMIT 1
      )`
      : sql`(
        SELECT p.id FROM run_picks p
        JOIN signals s ON s.id = p.signal_id
        WHERE p.status = 'queued' AND s.state = 'scored' AND p.plan_id = ${planId}
        ORDER BY p.position ASC
        LIMIT 1
      )`;

  const rows = await db
    .update(runPicks)
    .set({ status: "claimed", claimedTraceId: traceId, claimedAt: nowIso })
    .where(sql`${runPicks.id} = ${candidate}`)
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
 * Retires picks claimed by a run that is no longer alive: a render that
 * failed, or one killed outright by an Actions timeout, a Ctrl-C, a laptop
 * closing. They are **cancelled, not requeued** (operator direction
 * 2026-09-03).
 *
 * This is a deliberate reversal. Requeueing was added 2026-09-01 so a killed
 * render's story would not be silently lost — and it was the mechanism
 * behind the wrong video of 2026-09-03: a pick from that morning, whose
 * render had died at SCRIPT, came back onto the queue in the middle of a run
 * the operator had just started for a different story, and took its only
 * slot. The keys were spent on a story chosen in an earlier session.
 *
 * Cancelling is what the operator asked for instead: a failed run is
 * reported as failed on stage 4, its pick leaves the queue, and re-choosing
 * that story is one click on a list this system was already ranking for
 * them. Nothing is silently retried, and no token is ever spent on a pick
 * whose run the operator has already watched fail.
 *
 * Still scoped to picks whose signal is still `scored`: a pick whose story
 * has since been written was genuinely made, whatever happened afterwards,
 * and recording that as `cancelled` would be false.
 */
export async function retireStrandedPicks(db: AppDb, liveTraceIds: readonly string[]): Promise<number> {
  const claimed = await db.select().from(runPicks).where(eq(runPicks.status, "claimed")).all();
  const live = new Set(liveTraceIds);
  const stranded = claimed.filter((row) => row.claimedTraceId === null || !live.has(row.claimedTraceId));
  if (stranded.length === 0) return 0;

  const signalRows = await db.select().from(signals).where(inArray(signals.id, stranded.map((row) => row.signalId))).all();
  const stillScored = new Set(signalRows.filter((row) => row.state === "scored").map((row) => row.id));

  const retireable = stranded.filter((row) => stillScored.has(row.signalId)).map((row) => row.id);
  if (retireable.length === 0) return 0;

  await db.update(runPicks).set({ status: "cancelled" }).where(inArray(runPicks.id, retireable)).run();
  return retireable.length;
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
