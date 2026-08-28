import { desc, eq } from "drizzle-orm";
import { execAtomic, type AppDb, type RawSqlClient } from "../../../db/client.ts";
import { directives, signals } from "../../../db/schema.ts";
import { DEFAULT_DIRECTIVE, DirectiveSchema, type Directive } from "./directive-schema.ts";

export interface ActiveSettings {
  version: number;
  directive: Directive;
  rawText: string;
  createdAt: string;
}

export async function getSettings(db: AppDb): Promise<ActiveSettings | null> {
  const row = await db.select().from(directives).where(eq(directives.status, "active")).get();
  if (!row) return null;
  return { version: row.version, directive: DirectiveSchema.parse(JSON.parse(row.compiledJson)), rawText: row.rawText, createdAt: row.createdAt };
}

export interface DryRunResult {
  wouldSkip: { signalId: string; title: string; reason: string }[];
  wouldPick: { signalId: string; title: string }[];
}

/**
 * CONSOLE_SPEC.md §3: "replays the last 20 signals through the filter,
 * shows what would've been skipped" — a pure preview, no DB write (the
 * console UI's own "mandatory dry-run-before-activate" gate calls this,
 * then calls updateSettings separately with the same candidate if the
 * operator confirms; src/console/lib/types.ts's DryRunResult, the contract
 * Phase 7 already shipped against, has no draft/version field to persist
 * against). The pipeline runner that actually consumes
 * focus_games/preferred_source_ids/diversity_mode at FOOTAGE SELECT/SCRIPT
 * (ARCHITECTURE.md §5) doesn't exist yet as of this phase — exclude_topics
 * is the one field whose effect is fully knowable from a signal's title
 * alone, so it's what this preview actually simulates.
 */
export async function dryRunSettings(db: AppDb, candidate: Directive): Promise<DryRunResult> {
  const recentSignals = await db.select().from(signals).orderBy(desc(signals.observedAt)).limit(20).all();

  const wouldSkip: DryRunResult["wouldSkip"] = [];
  const wouldPick: DryRunResult["wouldPick"] = [];
  for (const signal of recentSignals) {
    const hitTopic = candidate.excludeTopics.find((topic) => signal.title.toLowerCase().includes(topic.toLowerCase()));
    if (hitTopic) wouldSkip.push({ signalId: signal.id, title: signal.title, reason: `matches excluded topic "${hitTopic}"` });
    else wouldPick.push({ signalId: signal.id, title: signal.title });
  }

  return { wouldSkip, wouldPick };
}

/**
 * `PUT /console/settings` — activates `candidate` immediately (the console
 * UI already ran dryRunSettings client-side before calling this; there is
 * no server-side draft token in this contract). Superseding whatever's
 * currently active and inserting the new active row are two different
 * statement types (UPDATE vs. INSERT), so this goes through
 * db/client.ts's execAtomic for real atomicity — same reasoning as
 * resetToDefaults below, which this function now shares its
 * implementation with.
 */
export async function updateSettings(db: AppDb, rawClient: RawSqlClient, candidate: Directive, rawText: string, now: () => number = Date.now): Promise<ActiveSettings> {
  return activateCompiledDirective(db, rawClient, candidate, rawText, now);
}

/** CONSOLE_SPEC.md §3: reset-defaults compiles and activates immediately — no dry-run gate for a known-safe default. */
export async function resetToDefaults(db: AppDb, rawClient: RawSqlClient, now: () => number = Date.now): Promise<ActiveSettings> {
  return activateCompiledDirective(db, rawClient, DEFAULT_DIRECTIVE, "", now);
}

async function activateCompiledDirective(
  db: AppDb,
  rawClient: RawSqlClient,
  directive: Directive,
  rawText: string,
  now: () => number,
): Promise<ActiveSettings> {
  const nowIso = new Date(now()).toISOString();
  await execAtomic(rawClient, [
    { sql: `UPDATE directives SET status = 'superseded' WHERE status = 'active'`, params: [] },
    {
      sql: `INSERT INTO directives (created_at, raw_text, compiled_json, status, parent_version) VALUES (?, ?, ?, 'active', NULL)`,
      params: [nowIso, rawText, JSON.stringify(directive)],
    },
  ]);

  const row = await db.select().from(directives).where(eq(directives.status, "active")).get();
  if (!row) throw new Error("activateCompiledDirective: no active directive row after activation — this should be unreachable");
  return { version: row.version, directive, rawText: row.rawText, createdAt: row.createdAt };
}

/**
 * `POST /console/directive` — the raw-text steering path. Layers the
 * operator's free text onto the *current* active settings as
 * `editorialNote` (the only field free text is ever allowed to reach,
 * CONSOLE_SPEC.md §3) rather than resetting every other field to its
 * default, so "make today's videos punchier" doesn't silently wipe
 * focus_games/voice_pool/etc.
 */
export function compileDirectiveFromRawText(current: Directive | null, rawText: string): Directive {
  const base = current ?? DEFAULT_DIRECTIVE;
  return { ...base, editorialNote: rawText.slice(0, 280) };
}
