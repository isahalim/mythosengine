import { desc, gte } from "drizzle-orm";
import type { AppDb } from "../../../db/client.ts";
import { footageSegments, footageSources, renders, runs, signals } from "../../../db/schema.ts";
import { STALE_RUN_THRESHOLD_MS } from "../../../db/runs.ts";
import { isPipelineEnabled } from "./killswitch.ts";
import { getSettings } from "./settings.ts";
import { DEFAULT_DIRECTIVE } from "./directive-schema.ts";
import { listExports, type ExportListItem } from "./exports.ts";
import { ROTATABLE_KEY_NAMES, type RotatableKeyName } from "./keys.ts";
import { Vault, type VaultKv } from "../../lib/vault.ts";
import type { KvLike } from "../../lib/drivers/cache-kv.ts";
import { listMcpTokens, type McpTokenSummary } from "../mcp/tokens.ts";

// Every shape below matches src/console/lib/types.ts exactly — that's the
// contract the Phase 7 frontend already shipped against.

interface PipelinePulse {
  window: "24h";
  signalsObserved: number;
  scripted: number;
  rendered: number;
  exported: number;
  liveRun: { stage: string; startedAt: string } | null;
  nextCronAt: string | null;
}

interface AuditFlagCount {
  reason: string;
  count: number;
}

interface FootageHealthEntry {
  game: string;
  segmentCount: number;
  avgUsedCount: number;
  lowInventory: boolean;
}

interface QuotaSnapshot {
  groqRequestsToday: number;
  groqRequestsCeiling: number;
  youtubeUnitsToday: number;
  youtubeUnitsCeiling: number;
  actionsMinutesToday: number;
  actionsMinutesCeiling: number;
  kvStorageBytesUsed: number;
  kvStorageBytesCeiling: number;
}

type LiveStatus = "live" | "degraded" | "down" | "unknown";

interface TtsStatus {
  status: LiveStatus;
  lastCheckedAt: string;
  consecutiveFailures: number;
}

interface KeyStatus {
  name: string;
  status: LiveStatus;
  fingerprint: string | null;
  last4: string | null;
  lastValidatedAt: string | null;
  lastRotatedAt: string | null;
  rotatable: boolean;
}

interface DirectiveSummary {
  version: number;
  createdAt: string;
  compiled: typeof DEFAULT_DIRECTIVE;
}

export interface ConsoleSummary {
  pipelinePulse: PipelinePulse;
  readyForReview: ExportListItem[];
  reviewed: ExportListItem[];
  auditFlags: AuditFlagCount[];
  footageHealth: FootageHealthEntry[];
  quota: QuotaSnapshot;
  ttsStatus: TtsStatus;
  settings: DirectiveSummary;
  keys: KeyStatus[];
  mcpTokens: McpTokenSummary[];
  killswitch: { enabled: boolean };
}

const LOW_INVENTORY_THRESHOLD_AVG_USED = 5;

// ARCHITECTURE.md §10's documented ceilings — usage-today tracking isn't
// wired up yet (no token/quota accounting exists in this codebase), so
// every "today" field is honestly 0 rather than a fabricated number; only
// the ceilings are real.
const QUOTA_CEILINGS = {
  groqRequestsCeiling: 14_400,
  youtubeUnitsCeiling: 10_000,
  actionsMinutesCeiling: 2_000,
  kvStorageBytesCeiling: 1_073_741_824,
};

async function getAuditFlags(db: AppDb, now: () => number): Promise<AuditFlagCount[]> {
  const since = new Date(now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const recentRenders = await db.select().from(renders).where(gte(renders.createdAt, since)).all();
  const counts = new Map<string, number>();
  for (const render of recentRenders) {
    if (!render.auditResult) continue;
    try {
      const parsed = JSON.parse(render.auditResult) as { flags?: string[] };
      for (const reason of parsed.flags ?? []) counts.set(reason, (counts.get(reason) ?? 0) + 1);
    } catch {
      // malformed audit_result is itself worth surfacing, not silently dropped
      counts.set("unparseable_audit_result", (counts.get("unparseable_audit_result") ?? 0) + 1);
    }
  }
  return [...counts.entries()].map(([reason, count]) => ({ reason, count }));
}

/**
 * Edge TTS runs only in GitHub Actions (ARCHITECTURE.md §0) — the Worker
 * can never live-probe it directly. This reads the same `runs` rows the
 * Discord alert (src/server/alerts/discord.ts) watches ("2 failures in a
 * row") rather than fabricating a live check the Worker can't perform.
 */
async function getTtsStatus(db: AppDb, now: () => number): Promise<TtsStatus> {
  const recentRuns = await db.select().from(runs).where(gte(runs.startedAt, new Date(now() - 24 * 60 * 60 * 1000).toISOString())).orderBy(desc(runs.startedAt)).all();
  const ttsRuns = recentRuns.filter((r) => r.stage === "tts");
  if (ttsRuns.length === 0) return { status: "unknown", lastCheckedAt: new Date(now()).toISOString(), consecutiveFailures: 0 };

  let consecutiveFailures = 0;
  for (const run of ttsRuns) {
    if (run.status === "failed") consecutiveFailures++;
    else break;
  }
  const status: LiveStatus = consecutiveFailures === 0 ? "live" : consecutiveFailures === 1 ? "degraded" : "down";
  return { status, lastCheckedAt: ttsRuns[0].startedAt, consecutiveFailures };
}

async function getKeyStatuses(vaultKv: VaultKv, masterKeyB64: string): Promise<KeyStatus[]> {
  const vault = new Vault(vaultKv, masterKeyB64);
  const statuses: KeyStatus[] = [];
  for (const name of ROTATABLE_KEY_NAMES as readonly RotatableKeyName[]) {
    const metadata = await vault.getMetadata(name);
    statuses.push({
      name,
      status: metadata ? "unknown" : "down", // "unknown" until a periodic live-check job exists — never fabricated as "live"
      fingerprint: metadata?.fingerprint ?? null,
      last4: metadata?.last4 ?? null,
      lastValidatedAt: null, // not tracked separately from rotation-time validation yet
      lastRotatedAt: null,
      rotatable: true,
    });
  }
  return statuses;
}

/** `GET /console/summary` — one round-trip for the whole bento dashboard (CONSOLE_SPEC.md §4). */
export async function getConsoleSummary(db: AppDb, killswitchKv: KvLike, vaultKv: VaultKv, masterKeyB64: string, now: () => number = Date.now): Promise<ConsoleSummary> {
  const since = new Date(now() - 24 * 60 * 60 * 1000).toISOString();
  const recentSignals = await db.select().from(signals).where(gte(signals.observedAt, since)).all();

  let scripted = 0;
  let exported = 0;
  for (const signal of recentSignals) {
    if (signal.state === "scripted" || signal.state === "critiqued") scripted++;
    else if (signal.state === "exported") exported++;
  }
  const recentRenders = await db.select().from(renders).where(gte(renders.createdAt, since)).all();
  const rendered = recentRenders.filter((r) => r.status === "rendered").length;

  // A `running` row only counts as live if it started recently enough to
  // plausibly still be running. GitHub Actions kills a job that exceeds its
  // timeout without giving it any chance to close its row, so an abandoned
  // run stays `running` forever — and reporting that as the live stage is
  // how the console came to show "Refreshing footage library" with a filled
  // progress bar for hours after the job was dead (2026-08-29). The
  // pipeline sweeps these rows on its next run (db/runs.ts's reapStaleRuns);
  // this guard means the dashboard stops lying immediately rather than
  // waiting for that to happen.
  const liveRunRow = await db.select().from(runs).where(gte(runs.startedAt, since)).orderBy(desc(runs.startedAt)).limit(1).get();
  const liveRunIsFresh = liveRunRow !== undefined && now() - Date.parse(liveRunRow.startedAt) < STALE_RUN_THRESHOLD_MS;
  const liveRun = liveRunRow && liveRunRow.status === "running" && liveRunIsFresh ? { stage: liveRunRow.stage, startedAt: liveRunRow.startedAt } : null;

  const [readyForReview, reviewed, auditFlags, ttsStatus, keys, mcpTokens, settings] = await Promise.all([
    listExports(db, "ready_for_review"),
    listExports(db).then((all) => all.filter((e) => e.status === "downloaded" || e.status === "reviewed").slice(0, 10)),
    getAuditFlags(db, now),
    getTtsStatus(db, now),
    getKeyStatuses(vaultKv, masterKeyB64),
    listMcpTokens(db),
    getSettings(db),
  ]);

  const segments = await db.select().from(footageSegments).all();
  // Only enabled sources count as inventory. A segment from a retired
  // channel (db/migrations/0008) still exists and still backs the exports
  // that used it, but FOOTAGE SELECT will never claim it again — counting it
  // here would report a game as healthy while the pipeline could not
  // actually render it, which is exactly the kind of confident-but-wrong
  // dashboard number this console is supposed to not have.
  const sources = (await db.select().from(footageSources).all()).filter((s) => s.enabled === 1);
  const gameById = new Map(sources.map((s) => [s.id, s.game]));
  const byGame = new Map<string, { count: number; totalUsed: number }>();
  for (const segment of segments) {
    const game = gameById.get(segment.footageSourceId);
    if (game === undefined) continue;
    const bucket = byGame.get(game) ?? { count: 0, totalUsed: 0 };
    bucket.count += 1;
    bucket.totalUsed += segment.usedCount;
    byGame.set(game, bucket);
  }
  const footageHealth: FootageHealthEntry[] = [...byGame.entries()].map(([game, { count, totalUsed }]) => {
    const avgUsedCount = count > 0 ? totalUsed / count : 0;
    return { game, segmentCount: count, avgUsedCount, lowInventory: avgUsedCount >= LOW_INVENTORY_THRESHOLD_AVG_USED };
  });

  return {
    pipelinePulse: { window: "24h", signalsObserved: recentSignals.length, scripted, rendered, exported, liveRun, nextCronAt: null },
    readyForReview,
    reviewed,
    auditFlags,
    footageHealth,
    quota: { groqRequestsToday: 0, youtubeUnitsToday: 0, actionsMinutesToday: 0, kvStorageBytesUsed: 0, ...QUOTA_CEILINGS },
    ttsStatus,
    settings: settings
      ? { version: settings.version, createdAt: settings.createdAt, compiled: settings.directive }
      : { version: 0, createdAt: new Date(now()).toISOString(), compiled: DEFAULT_DIRECTIVE },
    keys,
    mcpTokens,
    killswitch: { enabled: await isPipelineEnabled(killswitchKv) },
  };
}
