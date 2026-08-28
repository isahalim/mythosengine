import { DEFAULT_VOICE_POOL } from "../../config/voices.ts";

/**
 * Diversity logic for the default "3 different games, 3 different topics,
 * 3 different voices a day" posture (ARCHITECTURE.md §5.3/§5.5/§5.6,
 * CONSOLE_SPEC.md §3's `diversity_mode`). Pure functions over already-
 * queried "what has today's run used so far" data — no DB access here, so
 * this stays trivially testable; the caller queries `scripts.created_at`/
 * `renders.created_at` for today's rows and passes in the derived lists.
 */

export interface DiversitySettings {
  voicePool: readonly string[] | null; // null = DEFAULT_VOICE_POOL
  preferredSourceIds: readonly string[];
  diversityMode: boolean;
}

/**
 * Reorders `candidates` so items not in `usedToday` come first, preserving
 * relative order within each group. When `diversityMode` is off, or when
 * every candidate has already been used today (nothing left to diversify
 * into), returns `candidates` unchanged rather than an empty/degenerate
 * result — diversity is a preference, not a constraint that can starve a
 * run.
 */
export function preferUnusedToday<T>(candidates: readonly T[], usedToday: readonly T[], diversityMode: boolean): T[] {
  if (!diversityMode) return [...candidates];
  const used = new Set(usedToday);
  const unused = candidates.filter((c) => !used.has(c));
  return unused.length > 0 ? unused : [...candidates];
}

/**
 * FOOTAGE SELECT (ARCHITECTURE.md §5.5): which games are worth trying
 * first for today's render, before falling back to claimNextFootageSegment
 * (db/footage-select.ts)'s own used_count/last_used_at rotation among
 * whichever game is finally chosen.
 */
export function pickGamesForToday(eligibleGames: readonly string[], gamesUsedToday: readonly string[], diversityMode: boolean): string[] {
  return preferUnusedToday(eligibleGames, gamesUsedToday, diversityMode);
}

/**
 * TTS voice selection (ARCHITECTURE.md §5.6). `settings.voicePool: null`
 * means "use the full default curated pool," not "no eligible voices."
 */
export function pickVoicesForToday(settings: DiversitySettings, voicesUsedToday: readonly string[]): string[] {
  const pool = settings.voicePool ?? DEFAULT_VOICE_POOL;
  return preferUnusedToday(pool, voicesUsedToday, settings.diversityMode);
}

/**
 * SCRIPT source weighting (ARCHITECTURE.md §5.3): `preferredSourceIds`
 * (empty = no preference, all sources eligible) ranks first, then within
 * that ranking, diversity_mode prefers sources not already used today.
 */
export function weightSourcesForToday(
  eligibleSourceIds: readonly string[],
  settings: DiversitySettings,
  sourceIdsUsedToday: readonly string[],
): string[] {
  const preferred = new Set(settings.preferredSourceIds);
  const ranked =
    preferred.size === 0
      ? eligibleSourceIds
      : [...eligibleSourceIds].sort((a, b) => Number(preferred.has(b)) - Number(preferred.has(a)));
  return preferUnusedToday(ranked, sourceIdsUsedToday, settings.diversityMode);
}
