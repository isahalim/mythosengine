import { desc, gte } from "drizzle-orm";
import type { AppDb } from "../../../db/client.ts";
import { renders, runs } from "../../../db/schema.ts";
import { postAlert } from "./discord.ts";

const AUDIT_FLAG_RATE_THRESHOLD = 0.2;
const CONSECUTIVE_FAILURE_THRESHOLD = 3;
const TTS_CONSECUTIVE_FAILURE_THRESHOLD = 2;

export interface AlertCheckResult {
  fired: string[]; // which condition(s) fired, for the caller to log/assert on
}

/**
 * AGENT_PLAYBOOK.md Part IV's four alert conditions, evaluated against
 * `runs`/`renders`. Not invoked by anything yet — the WATCH→...→EXPORT
 * runner these conditions are meant to fire at the end of doesn't exist in
 * this codebase (it's a GitHub Actions job, ARCHITECTURE.md §0, not built
 * in this phase). This is the checkable unit a future session's runner
 * calls after each run, same "build the checkable piece now, wire in the
 * caller when it exists" pattern as src/lib/drivers/embed-local-minilm.ts's
 * typed stub.
 */
export async function checkAndAlert(db: AppDb, webhookUrl: string, now: () => number = Date.now, fetchImpl?: typeof fetch): Promise<AlertCheckResult> {
  const fired: string[] = [];
  const since24h = new Date(now() - 24 * 60 * 60 * 1000).toISOString();

  const recentRenders = await db.select().from(renders).where(gte(renders.createdAt, since24h)).all();
  if (recentRenders.length > 0) {
    const flaggedCount = recentRenders.filter((r) => {
      if (!r.auditResult) return false;
      try {
        return ((JSON.parse(r.auditResult) as { flags?: string[] }).flags?.length ?? 0) > 0;
      } catch {
        return true; // an unparseable audit_result is itself worth flagging
      }
    }).length;
    if (flaggedCount / recentRenders.length > AUDIT_FLAG_RATE_THRESHOLD) {
      fired.push("audit_flag_rate");
      await postAlert(webhookUrl, `AUDIT SUMMARY flag rate over the last 24h: ${flaggedCount}/${recentRenders.length} renders flagged (informational, nothing was blocked).`, fetchImpl);
    }
  }

  const recentTtsRuns = await db.select().from(runs).where(gte(runs.startedAt, since24h)).orderBy(desc(runs.startedAt)).all();
  const ttsRuns = recentTtsRuns.filter((r) => r.stage === "tts");
  let consecutiveTtsFailures = 0;
  for (const run of ttsRuns) {
    if (run.status === "failed") consecutiveTtsFailures++;
    else break;
  }
  if (consecutiveTtsFailures >= TTS_CONSECUTIVE_FAILURE_THRESHOLD) {
    fired.push("tts_failing");
    await postAlert(webhookUrl, `Edge TTS driver has failed ${consecutiveTtsFailures} runs in a row — the free ride may have ended.`, fetchImpl);
  }

  const exportRuns = recentTtsRuns.filter((r) => r.stage === "export");
  if (exportRuns[0]?.status === "failed") {
    fired.push("export_write_failed");
    await postAlert(webhookUrl, "A KV export write failed.", fetchImpl);
  }

  const stagesSeen = new Set(recentTtsRuns.map((r) => r.stage));
  for (const stage of stagesSeen) {
    const stageRuns = recentTtsRuns.filter((r) => r.stage === stage);
    let consecutiveFailures = 0;
    for (const run of stageRuns) {
      if (run.status === "failed") consecutiveFailures++;
      else break;
    }
    if (consecutiveFailures >= CONSECUTIVE_FAILURE_THRESHOLD) {
      fired.push(`stage_failing:${stage}`);
      await postAlert(webhookUrl, `Stage "${stage}" has failed ${consecutiveFailures} runs in a row.`, fetchImpl);
    }
  }

  return { fired };
}
