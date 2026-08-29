#!/usr/bin/env node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desc, eq, gte, inArray } from "drizzle-orm";
import { footageSegments, footageSources, renders, scripts, signals } from "../../db/schema.ts";
import { finishRun, reapStaleRuns, startRun } from "../../db/runs.ts";
import { claimNextFootageSegment } from "../../db/footage-select.ts";
import { isPipelineEnabled } from "../../src/server/console/killswitch.ts";
import { getSettings } from "../../src/server/console/settings.ts";
import { DEFAULT_DIRECTIVE } from "../../src/server/console/directive-schema.ts";
import { checkAndAlert } from "../../src/server/alerts/rules.ts";
import { pickGamesForToday, pickVoicesForToday, weightSourcesForToday } from "../../src/lib/pipeline/diversity.ts";
import { generateScript } from "../../src/lib/pipeline/script.ts";
import { critiqueScript } from "../../src/lib/pipeline/critic.ts";
import { buildCaptionCues } from "../../src/lib/pipeline/captions.ts";
import { pickTtsRate } from "../../src/lib/pipeline/tts-rate.ts";
import { computeAuditSummary, type FootageProvenance } from "../../src/lib/pipeline/audit.ts";
import { runExport } from "../../src/lib/pipeline/export.ts";
import { readClipFromLibrary } from "../../src/lib/footage/library.ts";
import { EdgeTtsDriver } from "../../src/lib/drivers/tts-edge.ts";
import { FfmpegRenderDriver } from "../../src/lib/drivers/render-ffmpeg.ts";
import { KvExportDriver } from "../../src/lib/drivers/export-kv.ts";
import { createGroqDriverFromEnv, createGroqLimiter } from "../../src/lib/drivers/resolve-groq-driver.ts";
import { buildPipelineEnv, HOT_KV_NAMESPACE_ID } from "./env.ts";

const REPO_DIR = process.cwd();

function todayStartIso(): string {
  return `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
}

/**
 * RENDER (ARCHITECTURE.md §5), one signal end-to-end per invocation —
 * matching the "3 render jobs/day" quota framing (§10), not a 3x-loop in
 * one job. Invoked 3x/day by .github/workflows/render.yml. Every stage is
 * recorded as its own `runs` row so `checkAndAlert` (called at the end) has
 * real consecutive-failure data to evaluate — the first caller either has
 * ever had.
 */
async function main(): Promise<void> {
  const env = buildPipelineEnv();
  // A previous run killed by the Actions job timeout leaves its row
  // `running` forever, which the console then reports as a live stage.
  // Swept here rather than in the console: this is a write, and the
  // pipeline owns the runs table.
  const reaped = await reapStaleRuns(env.db);
  if (reaped > 0) console.warn(`Reaped ${reaped} abandoned run row(s) left behind by a killed job.`);

  const traceId = crypto.randomUUID();

  if (!(await isPipelineEnabled(env.hotKv))) {
    console.warn("Pipeline killswitch is off — skipping this RENDER run.");
    return;
  }

  const scoredSignals = await env.db.select().from(signals).where(eq(signals.state, "scored")).all();
  if (scoredSignals.length === 0) {
    console.warn("RENDER: no scored signals available — nothing to do this cycle.");
    return;
  }

  const activeSettings = await getSettings(env.db);
  const directive = activeSettings?.directive ?? DEFAULT_DIRECTIVE;
  const since = todayStartIso();

  // ---- pick a signal: weight by preferredSourceIds, then diversity_mode excludes today's already-picked sources ----
  // Note: .select() here is deliberately bare (no field-picking object) —
  // TypeScript collapses drizzle's field-mapping select overload to 0
  // arguments when the receiver is typed as AppDb (a union of three
  // dialects' distinct builder classes), so `.select({...})` fails to
  // typecheck even though it runs fine. A join without field-picking
  // returns one nested object per table (`row.signals.sourceId`, not
  // `row.sourceId`) — that nesting is what the `.map` below relies on.
  const todaysScriptSources = await env.db
    .select()
    .from(scripts)
    .innerJoin(signals, eq(signals.id, scripts.signalId))
    .where(gte(scripts.createdAt, since))
    .all();
  const sourceIdsUsedToday = todaysScriptSources.map((r) => r.signals.sourceId);
  const eligibleSourceIds = [...new Set(scoredSignals.map((s) => s.sourceId))];
  const rankedSourceIds = weightSourcesForToday(
    eligibleSourceIds,
    { voicePool: directive.voicePool, preferredSourceIds: directive.preferredSourceIds, diversityMode: directive.diversityMode },
    sourceIdsUsedToday,
  );

  const chosenSignal =
    rankedSourceIds.map((sourceId) => scoredSignals.filter((s) => s.sourceId === sourceId)).find((candidates) => candidates.length > 0)?.reduce((best, s) => (s.engagementScore > best.engagementScore ? s : best)) ??
    scoredSignals[0];

  const llm = createGroqDriverFromEnv(env.groqApiKey, createGroqLimiter());

  // ---- SCRIPT ----
  const scriptRunId = await startRun(env.db, "script", traceId);
  const scriptResult = await generateScript(env.rawClient, chosenSignal, llm);
  if (!scriptResult.ok) {
    await finishRun(env.db, scriptRunId, "failed", scriptResult.error.kind);
    throw new Error(`SCRIPT failed: ${scriptResult.error.message}`);
  }
  await finishRun(env.db, scriptRunId, "succeeded");
  const script = scriptResult.value;

  // ---- CRITIC ----
  const criticRunId = await startRun(env.db, "critic", traceId);
  const criticResult = await critiqueScript(env.rawClient, script, chosenSignal, llm);
  if (!criticResult.ok) {
    await finishRun(env.db, criticRunId, "failed", criticResult.error.kind);
    throw new Error(`CRITIC failed: ${criticResult.error.message}`);
  }
  await finishRun(env.db, criticRunId, "succeeded");
  const critic = criticResult.value;

  // ---- FOOTAGE SELECT ----
  const todaysRenders = await env.db.select().from(renders).where(gte(renders.createdAt, since)).all();
  const todaysGameRows =
    todaysRenders.length === 0
      ? []
      : await env.db
          .select()
          .from(footageSegments)
          .innerJoin(footageSources, eq(footageSources.id, footageSegments.footageSourceId))
          .where(inArray(footageSegments.id, todaysRenders.map((r) => r.footageSegmentId)))
          .all();
  const gamesUsedToday = todaysGameRows.map((r) => r.footage_sources.game);

  const allGames = [...new Set((await env.db.select().from(footageSources).all()).map((r) => r.game))];
  const eligibleGames = directive.focusGames.length > 0 ? directive.focusGames.filter((g) => allGames.includes(g)) : allGames;
  const rankedGames = pickGamesForToday(eligibleGames, gamesUsedToday, directive.diversityMode);

  const footageRunId = await startRun(env.db, "footage_select", traceId);
  let claimedSegment = null;
  for (const game of rankedGames) {
    claimedSegment = await claimNextFootageSegment(env.db, game, new Date().toISOString());
    if (claimedSegment) break;
  }
  if (!claimedSegment) {
    await finishRun(env.db, footageRunId, "failed", "no_eligible_footage");
    throw new Error("FOOTAGE SELECT failed: no footage segment available for any eligible game");
  }
  await finishRun(env.db, footageRunId, "succeeded");

  const footage: FootageProvenance = {
    segmentId: claimedSegment.id,
    footageSourceId: claimedSegment.footageSourceId,
    sourceVideoId: claimedSegment.sourceVideoId,
    clipStartS: claimedSegment.clipStartS,
    clipEndS: claimedSegment.clipEndS,
    usedCount: claimedSegment.usedCount,
  };

  const clipBytesResult = await readClipFromLibrary(REPO_DIR, claimedSegment.libraryPath);
  if (!clipBytesResult.ok) throw new Error(`could not read footage clip from assets-library: ${clipBytesResult.error.message}`);

  const workDir = await mkdtemp(join(tmpdir(), "render-"));
  const footageClipPath = join(workDir, "footage.mp4");
  const narrationAudioPath = join(workDir, "narration.mp3");
  const outputPath = join(workDir, `${script.id}.mp4`);
  await writeFile(footageClipPath, clipBytesResult.value);

  try {
    // ---- TTS ----
    const voicesUsedToday = todaysRenders.map((r) => r.ttsVoice);
    const voice = pickVoicesForToday({ voicePool: directive.voicePool, preferredSourceIds: directive.preferredSourceIds, diversityMode: directive.diversityMode }, voicesUsedToday)[0];
    const rate = pickTtsRate(directive.ttsRateRange);

    const ttsRunId = await startRun(env.db, "tts", traceId);
    const ttsDriver = new EdgeTtsDriver();
    const ttsResult = await ttsDriver.synthesize({ text: `${script.hook} ${script.body} ${script.debateQuestion}`, voice, rate });
    if (!ttsResult.ok) {
      await finishRun(env.db, ttsRunId, "failed", ttsResult.error.kind);
      throw new Error(`TTS failed: ${ttsResult.error.message}`);
    }
    await finishRun(env.db, ttsRunId, "succeeded");
    await writeFile(narrationAudioPath, ttsResult.value.audio);
    const captionCues = buildCaptionCues(ttsResult.value.wordTimings);

    // ---- RENDER ----
    const renderRunId = await startRun(env.db, "render", traceId);
    const renderDriver = new FfmpegRenderDriver();
    const renderResult = await renderDriver.compose({ footageClipPath, narrationAudioPath, captionCues, outputPath });
    if (!renderResult.ok) {
      await finishRun(env.db, renderRunId, "failed", renderResult.error.kind);
      throw new Error(`RENDER failed: ${renderResult.error.message}`);
    }
    await finishRun(env.db, renderRunId, "succeeded");

    // ---- AUDIT SUMMARY (deterministic, no model call, never blocks) ----
    const recentScripts = await env.db.select().from(scripts).orderBy(desc(scripts.createdAt)).limit(100).all();
    const captionEndMs = captionCues.length > 0 ? captionCues[captionCues.length - 1].endMs : 0;
    const auditResult = computeAuditSummary({
      script: { hook: script.hook, body: script.body, debateQuestion: script.debateQuestion, wordCount: script.wordCount },
      originalityScore: critic.originalityScore,
      minOriginalityScore: directive.minOriginalityScore,
      policyFlags: critic.policyFlags,
      footage,
      voiceUsedToday: voicesUsedToday.includes(voice),
      recentScriptBodies: recentScripts.map((r) => r.body),
      narrationDurationS: renderResult.value.durationS,
      captionEndMs,
      durationToleranceMs: 500,
    });

    const renderId = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    await env.db
      .insert(renders)
      .values({
        id: renderId,
        scriptId: script.id,
        footageSegmentId: claimedSegment.id,
        ttsDriver: "edge-tts",
        ttsVoice: voice,
        durationS: renderResult.value.durationS,
        status: "rendered",
        auditResult: JSON.stringify(auditResult),
        createdAt: nowIso,
      })
      .run();

    // ---- EXPORT ----
    const exportRunId = await startRun(env.db, "export", traceId);
    const fileBytes = await readFile(outputPath);
    const exportDriver = new KvExportDriver({ accountId: env.accountId, namespaceId: HOT_KV_NAMESPACE_ID, apiToken: env.apiToken });
    const exportResult = await runExport(
      env.db,
      outputPath,
      fileBytes,
      {
        renderId,
        script: { hook: script.hook, body: script.body, debateQuestion: script.debateQuestion },
        critic: { originalityScore: critic.originalityScore, policyFlags: critic.policyFlags, verdict: critic.verdict, reason: critic.reason },
        footage,
        ttsSettings: { voice, rate, pitch: "+0Hz", volume: "+0%" },
        auditResult,
        suggestedTitle: script.hook.slice(0, 100),
        suggestedDescription: script.body.slice(0, 500),
        suggestedTags: [],
      },
      { export: exportDriver },
    );
    if (exportResult.status === "failed") {
      await finishRun(env.db, exportRunId, "failed", exportResult.error?.kind);
      throw new Error(`EXPORT failed: ${exportResult.error?.message}`);
    }
    await finishRun(env.db, exportRunId, "succeeded");

    console.warn(`RENDER complete: export ${exportResult.exportId} (${exportResult.sizeBytes} bytes) ready for review.`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }

  if (env.discordWebhookUrl) {
    await checkAndAlert(env.db, env.discordWebhookUrl);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
