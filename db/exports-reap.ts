import { and, eq, inArray, lt, or } from "drizzle-orm";
import type { AppDb } from "./client.ts";
import { exports as exportsTable, footageSegments, renderFootageParts, renders } from "./schema.ts";

/**
 * Retires exports whose review window has closed, and frees their blobs.
 *
 * **Why this exists now.** Export blobs moved from KV to R2 on 2026-08-31,
 * because KV caps one value at 25 MiB and a 128s render is ~42 MB. KV
 * expired a value by itself; R2 has no per-object TTL, and this deployment's
 * Cloudflare token cannot set a bucket lifecycle rule (it holds no R2
 * permission by design). Without a sweep the bucket would grow forever.
 *
 * **What it also fixes.** Nothing ever moved a row to `expired` — not under
 * KV either. The status existed in the schema and in `src/lib/state.ts`'s
 * transition table and was written by no one, so KV would silently drop a
 * blob and leave a row that still looked live in the review queue until the
 * operator clicked Download and got a bare 410. The row and the bytes now
 * retire together, in that order.
 *
 * Deletion first, then the row: a row marked `expired` while the bytes are
 * still there is a storage leak nothing records, whereas a deleted blob
 * under a live row is a download that fails loudly. If the delete throws,
 * the row stays live and the next sweep tries again.
 *
 * **The footage goes too** (operator direction 2026-09-01: "at the end no
 * sourced footage should survive/keep existing in the library"). Retiring an
 * export drops its `render_footage_parts` and then any `footage_segments`
 * row no surviving render still points at. The ordering matters and is the
 * whole reason this is not simply a DELETE: for as long as there is a video
 * to review, ARCHITECTURE.md §9 requires its footage provenance to be
 * readable, so the rows outlive the video by exactly zero days — not one
 * more, and not one less.
 *
 * One row per render is the exception, and it is a structural one worth
 * stating rather than discovering: `renders.footage_segment_id` is NOT NULL
 * and restricting, so the segment it names cannot be deleted while the
 * render row exists — and the render row has to exist, because
 * `pickVoicesForToday` and `pickGamesForToday` read the day's renders to
 * rotate. So a montage's clips all go and its first clip leaves a ~200-byte
 * provenance stub behind. No media survives either way; that is what "in the
 * library" means here, and the bytes were never stored to begin with.
 */

/** Statuses that still hold a blob. `discarded` freed its own at discard time; `expired` has already been through here. */
const LIVE_STATUSES = ["ready_for_review", "downloaded", "reviewed"] as const;

export interface ExpiredExport {
  id: string;
  storageKey: string;
}

/** Rows past their `expires_at` that still hold bytes. */
export async function findExpiredExports(db: AppDb, now: () => number = Date.now): Promise<ExpiredExport[]> {
  const nowIso = new Date(now()).toISOString();
  const rows = await db
    .select()
    .from(exportsTable)
    .where(
      and(
        lt(exportsTable.expiresAt, nowIso),
        or(...LIVE_STATUSES.map((status) => eq(exportsTable.status, status))),
      ),
    )
    .all();
  return rows.map((row) => ({ id: row.id, storageKey: row.storageKey }));
}

/**
 * Sweeps them. `removeBlob` is whatever store the caller has — the pipeline
 * hands in the export driver's `remove`, which goes through the Worker.
 *
 * A blob that will not delete leaves its row alone and is reported, never
 * swallowed: the caller logs the count and the reasons, and the next run
 * retries. Returning a partial result is the honest shape here, because
 * "three of five retired" is a real outcome.
 */
export async function reapExpiredExports(
  db: AppDb,
  removeBlob: (storageKey: string) => Promise<{ ok: boolean; error?: string }>,
  now: () => number = Date.now,
): Promise<{ retired: number; failures: { id: string; error: string }[]; segmentsFreed: number }> {
  const expired = await findExpiredExports(db, now);
  const failures: { id: string; error: string }[] = [];
  let retired = 0;

  for (const row of expired) {
    const removal = await removeBlob(row.storageKey);
    if (!removal.ok) {
      failures.push({ id: row.id, error: removal.error ?? "blob delete failed" });
      continue;
    }
    await db.update(exportsTable).set({ status: "expired" }).where(eq(exportsTable.id, row.id)).run();
    retired += 1;
  }

  const segmentsFreed = expired.length > 0 ? await purgeOrphanedFootage(db) : 0;

  return { retired, failures, segmentsFreed };
}

/**
 * Drops footage rows nothing can still be reviewed against.
 *
 * A segment is orphaned once no `render_footage_parts` row references it AND
 * no `renders.footage_segment_id` does — which is true precisely when every
 * render that used it has had its export retired. Sourced footage is
 * ephemeral now: the bytes never outlived the run that fetched them, and
 * after this the rows do not outlive the video either.
 *
 * Parts belonging to a retired export go first, because a part is what makes
 * its segment non-orphaned. Retired means the *export* is expired or
 * discarded; a render with no export at all is a failure whose rows are
 * still worth keeping, since it is the only record that the sourcing
 * happened.
 *
 * Deliberately expressed as reads plus targeted deletes rather than a
 * `DELETE ... WHERE NOT EXISTS`: CLAUDE.md forbids joins on an `AppDb` (D1's
 * column-keyed JSON collapses two `id` columns), and this runs over one
 * sweep's worth of rows, not the whole table.
 */
async function purgeOrphanedFootage(db: AppDb): Promise<number> {
  const deadStatuses = ["expired", "discarded"] as const;
  const deadExports = await db
    .select()
    .from(exportsTable)
    .where(or(...deadStatuses.map((status) => eq(exportsTable.status, status))))
    .all();
  if (deadExports.length === 0) return 0;

  const liveExports = await db
    .select()
    .from(exportsTable)
    .where(or(...LIVE_STATUSES.map((status) => eq(exportsTable.status, status))))
    .all();
  const liveRenderIds = new Set(liveExports.map((row) => row.renderId));

  // Renders whose only export is dead. A render still referenced by a live
  // export keeps everything, even if it also has a retired one.
  const deadRenderIds = [...new Set(deadExports.map((row) => row.renderId))].filter((id) => !liveRenderIds.has(id));
  if (deadRenderIds.length === 0) return 0;

  const doomedParts = await db.select().from(renderFootageParts).where(inArray(renderFootageParts.renderId, deadRenderIds)).all();
  const candidateSegmentIds = [...new Set(doomedParts.map((part) => part.footageSegmentId))];

  await db.delete(renderFootageParts).where(inArray(renderFootageParts.renderId, deadRenderIds)).run();

  if (candidateSegmentIds.length === 0) return 0;

  // Re-read what still points at those segments, now that the parts are
  // gone. `renders.footage_segment_id` is a restricting FK and a render row
  // outlives its export, so a segment named there is never orphaned — the
  // render row is deleted by nothing, which is correct: it is the record
  // that the video existed.
  const survivingParts = await db.select().from(renderFootageParts).where(inArray(renderFootageParts.footageSegmentId, candidateSegmentIds)).all();
  const stillReferenced = new Set(survivingParts.map((part) => part.footageSegmentId));

  const primaryRefs = await db.select().from(renders).where(inArray(renders.footageSegmentId, candidateSegmentIds)).all();
  for (const render of primaryRefs) stillReferenced.add(render.footageSegmentId);

  const orphaned = candidateSegmentIds.filter((id) => !stillReferenced.has(id));
  if (orphaned.length === 0) return 0;

  await db.delete(footageSegments).where(inArray(footageSegments.id, orphaned)).run();
  return orphaned.length;
}
