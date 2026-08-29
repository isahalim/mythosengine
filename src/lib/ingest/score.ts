import { eq, gte } from "drizzle-orm";
import { assertSignalTransition } from "../state.ts";
import { hexToSimhash, isNearDuplicate } from "./simhash.ts";
import { signals } from "../../../db/schema.ts";
import type { AppDb } from "../../../db/client.ts";

type Db = AppDb;
type Signal = typeof signals.$inferSelect;

const TRAILING_WINDOW_DAYS = 7;
/** Corroboration bonus per additional source reporting a near-duplicate story — same "12 aggregators collapse to one" signal MythosEngine's DEDUPE stage used, applied here to virality instead of trust. */
const CORROBORATION_BONUS = 0.1;

export interface ScoreResult {
  scored: number;
  rejectedAsDuplicate: number;
  rejectedAsFuture: number;
}

function clusterByNearDuplicate(items: Signal[]): Signal[][] {
  // Simple first-match clustering (not full pairwise union-find) — good
  // enough at WATCH's per-run volume, and the same tradeoff MythosEngine's
  // original DEDUPE stage made.
  const clusters: Signal[][] = [];
  for (const item of items) {
    const fp = hexToSimhash(item.simhash);
    const cluster = clusters.find((c) => isNearDuplicate(hexToSimhash(c[0].simhash), fp));
    if (cluster) cluster.push(item);
    else clusters.push([item]);
  }
  return clusters;
}

/**
 * SCORE stage (ARCHITECTURE.md §5.2): rejects future-dated signals outright
 * (a feed bug, not a real trend — never eligible to "win" a cluster),
 * clusters the rest of this batch's 'observed' signals by simhash
 * near-duplicate distance, promotes each cluster's highest-scoring member
 * to 'scored' with a bonus for corroboration (both within this batch and
 * against near-duplicates already in the trailing window from earlier
 * runs), and rejects the rest of the cluster as duplicates.
 */
export async function scoreObservedSignals(db: Db, now: Date = new Date()): Promise<ScoreResult> {
  const windowStart = new Date(now.getTime() - TRAILING_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const observed = await db.select().from(signals).where(eq(signals.state, "observed")).all();
  const windowSignals = await db.select().from(signals).where(gte(signals.observedAt, windowStart)).all();

  const result: ScoreResult = { scored: 0, rejectedAsDuplicate: 0, rejectedAsFuture: 0 };

  const future = observed.filter((s) => Date.parse(s.observedAt) > now.getTime());
  for (const signal of future) {
    assertSignalTransition("observed", "rejected");
    await db.update(signals).set({ state: "rejected" }).where(eq(signals.id, signal.id)).run();
    result.rejectedAsFuture++;
  }

  const eligible = observed.filter((s) => !future.includes(s));
  const clusters = clusterByNearDuplicate(eligible);

  for (const cluster of clusters) {
    const winner = cluster.reduce((best, s) => (s.engagementScore > best.engagementScore ? s : best));
    const priorCorroborators = windowSignals.filter(
      (s) => s.state !== "observed" && s.id !== winner.id && isNearDuplicate(hexToSimhash(s.simhash), hexToSimhash(winner.simhash)),
    ).length;
    const bonus = (cluster.length - 1 + priorCorroborators) * CORROBORATION_BONUS;

    assertSignalTransition("observed", "scored");
    await db
      .update(signals)
      .set({ state: "scored", engagementScore: winner.engagementScore + bonus })
      .where(eq(signals.id, winner.id))
      .run();
    result.scored++;

    for (const signal of cluster) {
      if (signal.id === winner.id) continue;
      assertSignalTransition("observed", "rejected");
      await db.update(signals).set({ state: "rejected" }).where(eq(signals.id, signal.id)).run();
      result.rejectedAsDuplicate++;
    }
  }

  return result;
}
