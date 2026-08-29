import { sql } from "drizzle-orm";
import type { AppDb } from "./client.ts";
import { footageSegments } from "./schema.ts";

export interface ClaimedFootageSegment {
  id: string;
  footageSourceId: string;
  sourceVideoId: string;
  clipStartS: number;
  clipEndS: number;
  libraryPath: string;
  usedCount: number;
}

/**
 * Atomically claims (and rotates) the least-recently-used footage segment
 * for a game, in one SQL statement. The selection and the used_count/
 * last_used_at update happen inside a single UPDATE...RETURNING with a
 * correlated subquery — there is no read-then-write window for a second
 * concurrent caller to race into, which is what actually matters for
 * correctness under concurrent requests (a single-threaded test can't
 * reproduce interleaving to prove this empirically, but the atomicity is
 * structural, not timing-dependent).
 *
 * The subquery/`RETURNING` list are expressed via `sql` template literals
 * rather than drizzle's `.select({...})`/`.returning({...})` field-mapping
 * overloads — TypeScript collapses those overloads to their 0-argument form
 * when the receiver is typed as `AppDb` (a union of three dialects'
 * distinct builder classes), so a plain `db.select({...})`/`.returning({...})`
 * fails to typecheck here even though it runs fine at the SQL level.
 * `sql` template values are still parameterized/escaped by drizzle, not
 * string-concatenated.
 *
 * Built against `AppDb` rather than a raw better-sqlite3 handle — the
 * raw-statement version this replaced could only ever run against the
 * local test dialect, not the D1 binding or the D1-over-HTTP client the
 * GitHub Actions pipeline runner needs.
 */
export async function claimNextFootageSegment(db: AppDb, game: string, nowIso: string): Promise<ClaimedFootageSegment | null> {
  const rows = await db
    .update(footageSegments)
    .set({ usedCount: sql`${footageSegments.usedCount} + 1`, lastUsedAt: nowIso })
    .where(
      sql`${footageSegments.id} = (
        SELECT fs.id FROM footage_segments fs
        JOIN footage_sources src ON src.id = fs.footage_source_id
        WHERE src.game = ${game}
        ORDER BY fs.used_count ASC, fs.last_used_at IS NOT NULL, fs.last_used_at ASC
        LIMIT 1
      )`,
    )
    .returning()
    .all();

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    footageSourceId: row.footageSourceId,
    sourceVideoId: row.sourceVideoId,
    clipStartS: row.clipStartS,
    clipEndS: row.clipEndS,
    libraryPath: row.libraryPath,
    usedCount: row.usedCount,
  };
}
