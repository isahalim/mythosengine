import { and, eq, lt, or } from "drizzle-orm";
import type { AppDb } from "./client.ts";
import { exports as exportsTable } from "./schema.ts";

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
): Promise<{ retired: number; failures: { id: string; error: string }[] }> {
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

  return { retired, failures };
}
