import { inArray } from "drizzle-orm";
import { z } from "zod";
import type { AppDb, RawSqlClient } from "../../../db/client.ts";
import { cancelPick, listQueuedPicks, queueRunPlan } from "../../../db/run-picks.ts";
import { signals } from "../../../db/schema.ts";
import { isTopic, TOPICS } from "./ideas.ts";

/**
 * The run plan the console submits at the end of steps 1-3 (plan v2 §7):
 * how many videos, each one's topic, each one's chosen idea.
 *
 * Validation lives here rather than in db/run-picks.ts because it is a
 * console concern — the pipeline reads the queue and must be able to trust
 * it, which means nothing unvalidated may enter it. A pick naming a signal
 * that does not exist, or one that has already been written about, is
 * rejected at this boundary with a reason, never queued for RENDER to
 * discover.
 */

/** The ceiling on one submission. Not a quota — `maxUploadsPerDay` (CONSOLE_SPEC.md §3) is the real one, enforced by the pipeline — just a bound on a single form. */
const MAX_VIDEOS_PER_PLAN = 6;

const RunPlanSchema = z.object({
  picks: z
    .array(
      z.object({
        topic: z.string().refine(isTopic, { message: `topic must be one of: ${TOPICS.join(", ")}` }),
        signalId: z.string().min(1),
      }),
    )
    .min(1)
    .max(MAX_VIDEOS_PER_PLAN),
});

export type QueuePlanResult =
  | { kind: "ok"; planId: string; queued: number }
  | { kind: "invalid"; message: string }
  | { kind: "unknown_signal"; signalIds: string[] }
  | { kind: "not_eligible"; signalIds: string[] };

/**
 * Validates and queues one plan.
 *
 * The eligibility check is the load-bearing part: a signal is only pickable
 * while it is `scored`. Anything past that has already been scripted, and
 * queueing it would produce a second video about a story the channel has
 * already covered — the diversity rule (ARCHITECTURE.md §5.3) exists to
 * prevent exactly that, and the operator picking by hand must not be a way
 * around it.
 */
export async function queuePlan(db: AppDb, rawClient: RawSqlClient, input: unknown, now: () => number = Date.now): Promise<QueuePlanResult> {
  const parsed = RunPlanSchema.safeParse(input);
  if (!parsed.success) return { kind: "invalid", message: parsed.error.issues[0]?.message ?? "invalid run plan" };

  const picks = parsed.data.picks;
  const signalIds = picks.map((pick) => pick.signalId);
  const duplicates = signalIds.filter((id, index) => signalIds.indexOf(id) !== index);
  if (duplicates.length > 0) return { kind: "invalid", message: `the same idea was picked twice: ${[...new Set(duplicates)].join(", ")}` };

  const rows = await db.select().from(signals).where(inArray(signals.id, signalIds)).all();
  const byId = new Map(rows.map((row) => [row.id, row]));

  const unknown = signalIds.filter((id) => !byId.has(id));
  if (unknown.length > 0) return { kind: "unknown_signal", signalIds: unknown };

  const ineligible = signalIds.filter((id) => byId.get(id)?.state !== "scored");
  if (ineligible.length > 0) return { kind: "not_eligible", signalIds: ineligible };

  const planId = await queueRunPlan(rawClient, picks, now);
  return { kind: "ok", planId, queued: picks.length };
}

export interface QueuedPickView {
  id: string;
  planId: string;
  position: number;
  topic: string;
  signalId: string;
  /** Null when the signal row has since been deleted — shown as a missing title, never as a fabricated one. */
  title: string | null;
  createdAt: string;
}

/** What the run view lists as waiting to be built. */
export async function listPlan(db: AppDb): Promise<QueuedPickView[]> {
  const picks = await listQueuedPicks(db);
  if (picks.length === 0) return [];

  const rows = await db
    .select()
    .from(signals)
    .where(inArray(signals.id, picks.map((pick) => pick.signalId)))
    .all();
  const titleById = new Map(rows.map((row) => [row.id, row.title]));

  return picks.map((pick) => ({
    id: pick.id,
    planId: pick.planId,
    position: pick.position,
    topic: pick.topic,
    signalId: pick.signalId,
    title: titleById.get(pick.signalId) ?? null,
    createdAt: pick.createdAt,
  }));
}

export type CancelPickResult = { kind: "ok" } | { kind: "not_found" };

/** Cancels one queued pick. A pick a render already claimed is not cancellable — see db/run-picks.ts. */
export async function cancelPlanPick(db: AppDb, id: string): Promise<CancelPickResult> {
  return (await cancelPick(db, id)) ? { kind: "ok" } : { kind: "not_found" };
}

/** Whether a given signal is still pickable — used by the ideas endpoint to hide what is already queued. */
export async function queuedSignalIds(db: AppDb): Promise<string[]> {
  const picks = await listQueuedPicks(db);
  return picks.map((pick) => pick.signalId);
}
