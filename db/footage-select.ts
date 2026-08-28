import type Database from "better-sqlite3";

export interface ClaimedFootageSegment {
  id: string;
  footage_source_id: string;
  source_video_id: string;
  clip_start_s: number;
  clip_end_s: number;
  library_path: string;
  used_count: number;
}

/**
 * Atomically claims (and rotates) the least-recently-used footage segment
 * for a game, in one SQL statement. The selection and the used_count/
 * last_used_at update happen inside a single UPDATE...RETURNING — there is
 * no read-then-write window for a second concurrent caller to race into,
 * which is what actually matters for correctness under concurrent requests
 * (a single-threaded test can't reproduce interleaving to prove this
 * empirically, but the atomicity is structural, not timing-dependent).
 */
export function claimNextFootageSegment(
  client: Database.Database,
  game: string,
  nowIso: string,
): ClaimedFootageSegment | null {
  const stmt = client.prepare(`
    UPDATE footage_segments
    SET used_count = used_count + 1, last_used_at = ?
    WHERE id = (
      SELECT fs.id FROM footage_segments fs
      JOIN footage_sources src ON src.id = fs.footage_source_id
      WHERE src.game = ?
      ORDER BY fs.used_count ASC, fs.last_used_at IS NOT NULL, fs.last_used_at ASC
      LIMIT 1
    )
    RETURNING id, footage_source_id, source_video_id, clip_start_s, clip_end_s, library_path, used_count
  `);
  const row = stmt.get(nowIso, game);
  return (row as ClaimedFootageSegment | undefined) ?? null;
}
