#!/usr/bin/env node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desc, eq, gte, inArray } from "drizzle-orm";
import { footageSegments, footageSources, renders, scripts, signals } from "../../db/schema.ts";
import { finishRun, reapStaleRuns, startRun } from "../../db/runs.ts";
import { reapExpiredExports } from "../../db/exports-reap.ts";
import { claimNextRunPick } from "../../db/run-picks.ts";
import { claimNextFootageSegment } from "../../db/footage-select.ts";
import { isPipelineEnabled } from "../../src/server/console/killswitch.ts";
import { getSettings } from "../../src/server/console/settings.ts";
import { DEFAULT_DIRECTIVE, DEFAULT_TARGET_DURATION_S } from "../../src/server/console/directive-schema.ts";
import { checkAndAlert } from "../../src/server/alerts/rules.ts";
import { pickGamesForToday, pickVoicesForToday, weightSourcesForToday } from "../../src/lib/pipeline/diversity.ts";
import { generateDiscourseScript } from "../../src/lib/pipeline/script.ts";
import { beatWordRanges } from "../../src/lib/pipeline/discourse.ts";
import { alignBeats } from "../../src/lib/pipeline/align.ts";
import { buildDirectedNarration, FLAT_DIRECTION } from "../../src/lib/pipeline/tts-direction.ts";
import { selectTtsDrivers, synthesizeWithFallback } from "../../src/lib/pipeline/tts-select.ts";
import { HOST_GEMINI_VOICE, resolveCharacterOverlay } from "../../src/lib/pipeline/character.ts";
import { extractKeywords } from "../../src/lib/pipeline/keywords.ts";
import { researchSignal, type ResearchBrief } from "../../src/lib/rag/research.ts";
import { saveResearchBrief } from "../../src/lib/rag/research-store.ts";
import { SignalsBm25Retriever } from "../../src/lib/rag/retriever.ts";
import { ArticleFetchDriver } from "../../src/lib/drivers/article-fetch.ts";
import { critiqueScript } from "../../src/lib/pipeline/critic.ts";
import { buildCaptionCues } from "../../src/lib/pipeline/captions.ts";
import { pickTtsRate } from "../../src/lib/pipeline/tts-rate.ts";
import { computeAuditSummary, type FootageProvenance, type ResearchProvenance } from "../../src/lib/pipeline/audit.ts";
import { runExport } from "../../src/lib/pipeline/export.ts";
import { readClipFromLibrary } from "../../src/lib/footage/library.ts";
import { GroqWhisperDriver } from "../../src/lib/drivers/groq-whisper.ts";
import { FfmpegRenderDriver } from "../../src/lib/drivers/render-ffmpeg.ts";
import { createGroqDriverFromEnv, createGroqLimiter } from "../../src/lib/drivers/resolve-groq-driver.ts";
import { buildPipelineEnv } from "./env.ts";

const REPO_DIR = process.cwd();

/**
 * The brief as the audit package records it: the citations and the model
 * that produced them, without the retrieved page text. A reviewer needs to
 * see what the script was grounded in and be able to check it; the fetched
 * article bodies are working material, and storing them in every export
 * would multiply KV usage for something nobody reads.
 */
function toResearchProvenance(brief: ResearchBrief | null): ResearchProvenance | null {
  if (!brief) return null;
  return { model: brief.model, summary: brief.summary, citations: brief.citations, toolCallsMade: brief.toolCallsMade };
}

function todayStartIso(): string {
  return `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
}

/**
 * RENDER (ARCHITECTURE.md §5), one signal end-to-end per invocation — not a
 * loop of three. Operator-dispatched on the self-hosted runner
 * (.github/workflows/render.yml); the 3x/day cron was removed 2026-08-31,
 * because the machine that has to source the footage is the operator's own
 * and a cron cannot assume it is awake. Every stage is recorded as its own
 * `runs` row so `checkAndAlert` (called at the end) has real
 * consecutive-failure data to evaluate — the first caller either has ever
 * had.
 */
async function main(): Promise<void> {
  const env = buildPipelineEnv();
  // A previous run killed by the Actions job timeout leaves its row
  // `running` forever, which the console then reports as a live stage.
  // Swept here rather than in the console: this is a write, and the
  // pipeline owns the runs table.
  const reaped = await reapStaleRuns(env.db);
  if (reaped > 0) console.warn(`Reaped ${reaped} abandoned run row(s) left behind by a killed job.`);

  // Export blobs live in R2 since 2026-08-31, and R2 has no per-object TTL
  // the way KV did — so the review window is enforced here rather than by
  // the store. Swept at the top of a run, like the stale-run reaper above
  // and for the same reason: this is a write, and the pipeline owns it.
  const { retired, failures } = await reapExpiredExports(env.db, async (key) => {
    const removal = await env.exportDriver.remove(key);
    return removal.ok ? { ok: true } : { ok: false, error: `${removal.error.kind}: ${removal.error.message}` };
  });
  if (retired > 0) console.warn(`Retired ${retired} export(s) past their review window and freed their blobs.`);
  for (const failure of failures) {
    // Reported, never swallowed. The row stays live and the next run retries.
    console.warn(`Could not free the blob for export ${failure.id}: ${failure.error}`);
  }

  /**
   * The console decides the trace, not this script.
   *
   * POST /console/dispatch writes a `runs` row, hands its id to the workflow
   * as `trace_id` (.github/workflows/render.yml), and stage 5 polls that id.
   * Minting one here regardless — which is what this did — meant the console
   * watched a trace this run never wrote to, so the waiting screen sat on
   * "waiting for the first script" even after the run had finished and
   * exported. GitHub's dispatch endpoint returns no run id, so the
   * identifier has to travel down; there is nothing to read back up.
   *
   * Unset on a hand-triggered or scheduled invocation, and minting one is
   * then exactly right.
   */
  const traceId = process.env.PIPELINE_TRACE_ID?.trim() || crypto.randomUUID();

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
  // Two queries and a Map rather than a SQL join, for the reason spelled out
  // in src/lib/rag/retriever.ts: a drizzle join over the D1 HTTP client
  // returns corrupted rows, because the generated select list is unaliased
  // and D1's column-keyed JSON collapses the two `id` columns into one —
  // shifting every field after the collision. Confirmed against the live
  // database, 2026-08-31. Both result sets here are one day's worth of rows.
  const todaysScripts = await env.db.select().from(scripts).where(gte(scripts.createdAt, since)).all();
  const todaysSignalIds = todaysScripts.map((row) => row.signalId);
  const sourceIdsUsedToday =
    todaysSignalIds.length === 0
      ? []
      : (await env.db.select().from(signals).where(inArray(signals.id, todaysSignalIds)).all()).map((row) => row.sourceId);
  const eligibleSourceIds = [...new Set(scoredSignals.map((s) => s.sourceId))];
  const rankedSourceIds = weightSourcesForToday(
    eligibleSourceIds,
    { voicePool: directive.voicePool, preferredSourceIds: directive.preferredSourceIds, diversityMode: directive.diversityMode },
    sourceIdsUsedToday,
  );

  const weightedPick =
    rankedSourceIds.map((sourceId) => scoredSignals.filter((s) => s.sourceId === sourceId)).find((candidates) => candidates.length > 0)?.reduce((best, s) => (s.engagementScore > best.engagementScore ? s : best)) ??
    scoredSignals[0];

  // ---- the operator's own pick, if they queued one (plan v2 §7 step 3) ----
  // Claimed atomically (db/run-picks.ts), so two concurrent renders cannot
  // take the same pick, and claimed *before* anything else in this run
  // spends a token. A queued pick outranks the diversity weighting for this
  // one invocation only: the operator chose this story deliberately, from a
  // list this system ranked for them. With an empty queue — the ordinary
  // scheduled case — nothing changes.
  const claimedPick = await claimNextRunPick(env.db, traceId, new Date().toISOString());
  const pickedSignal = claimedPick === null ? undefined : scoredSignals.find((s) => s.id === claimedPick.signalId);
  if (claimedPick !== null && pickedSignal === undefined) {
    // The claim succeeded (the signal was `scored` inside that statement)
    // but it is not in this run's candidate list — the two reads are
    // seconds apart and WATCH runs on its own schedule. Say so rather than
    // silently falling back: a pick that vanished is something the operator
    // will otherwise wait for and never see.
    console.warn(`RUN PICK ${claimedPick.id} named signal ${claimedPick.signalId}, which is no longer among the scored candidates — falling back to the weighted pick.`);
  }
  const chosenSignal = pickedSignal ?? weightedPick;
  if (pickedSignal !== undefined) console.warn(`RUN PICK: rendering the operator's queued ${claimedPick?.topic} pick — ${pickedSignal.title}`);

  const llm = createGroqDriverFromEnv(env.groqApiKey, createGroqLimiter());

  // ---- RESEARCH (RAG: BM25 retrieval + live source reads, driven by Groq tool-calling) ----
  // Deliberately not fatal. A retrieval outage, a rate limit, or a model
  // that cannot produce a citable brief costs this render its grounding and
  // nothing else — SCRIPT falls back to writing from the signal title, and
  // AUDIT SUMMARY flags the result as ungrounded so the reviewer knows
  // which kind of script they are reading. Losing the day's video to a
  // failed research call would be a strictly worse trade.
  const researchRunId = await startRun(env.db, "research", traceId);
  const researchResult = await researchSignal(
    llm,
    new SignalsBm25Retriever(env.db),
    new ArticleFetchDriver(),
    chosenSignal,
  );
  let research: ResearchBrief | null = null;
  if (researchResult.ok) {
    research = researchResult.value;
    await saveResearchBrief(env.db, chosenSignal.id, research);
    await finishRun(env.db, researchRunId, "succeeded");
    console.warn(`RESEARCH: ${research.citations.length} citation(s) from ${research.toolCallsMade.length} tool call(s).`);
  } else {
    await finishRun(env.db, researchRunId, "failed", `${researchResult.error.kind}: ${researchResult.error.message}`);
    console.warn(`RESEARCH failed (${researchResult.error.kind}: ${researchResult.error.message}) — continuing ungrounded.`);
  }

  // ---- SCRIPT (v2 discourse format: beats with a `move`, plan v2 §4) ----
  const targetDurationS = directive.targetDurationS ?? DEFAULT_TARGET_DURATION_S;
  const scriptRunId = await startRun(env.db, "script", traceId);
  const scriptResult = await generateDiscourseScript(env.rawClient, chosenSignal, llm, targetDurationS, research, Date.now, undefined, traceId);
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
  // Same in-memory join, same reason as above.
  const todaysSegments =
    todaysRenders.length === 0
      ? []
      : await env.db.select().from(footageSegments).where(inArray(footageSegments.id, todaysRenders.map((r) => r.footageSegmentId))).all();
  const allFootageSources = await env.db.select().from(footageSources).all();
  const gameBySourceId = new Map(allFootageSources.map((row) => [row.id, row.game]));
  const gamesUsedToday = todaysSegments.flatMap((row) => {
    const game = gameBySourceId.get(row.footageSourceId);
    return game === undefined ? [] : [game];
  });

  // Only enabled sources (db/migrations/0008) — a game whose every channel
  // has been retired must not be ranked as a candidate, or FOOTAGE SELECT
  // spends a claim attempt on a game it can never satisfy.
  const allGames = [...new Set(allFootageSources.filter((row) => row.enabled === 1).map((row) => row.game))];
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
  // Extension assigned after TTS, from the mime type the driver actually
  // returned: Edge emits MP3, Gemini WAV. FFmpeg probes by content and would
  // decode either under either name, but a `.mp3` holding WAV is a trap for
  // the next person to open the work directory.
  const outputPath = join(workDir, `${script.id}.mp4`);
  await writeFile(footageClipPath, clipBytesResult.value);

  try {
    // ---- TTS ----
    const voicesUsedToday = todaysRenders.map((r) => r.ttsVoice);
    const voice = pickVoicesForToday({ voicePool: directive.voicePool, preferredSourceIds: directive.preferredSourceIds, diversityMode: directive.diversityMode }, voicesUsedToday)[0];
    const rate = pickTtsRate(directive.ttsRateRange);

    // How many of today's renders already spent a Gemini TTS request. The
    // free tier's ceiling is per *day*, so this is the only count that can
    // decide whether the upgrade is still available.
    const geminiRendersToday = todaysRenders.filter((r) => r.ttsDriver === "gemini-tts").length;
    const selection = selectTtsDrivers(env.geminiApiKey, geminiRendersToday);
    if (selection.unavailableReason !== null) console.warn(`TTS: ${selection.unavailableReason}`);

    // The beats reach TTS two ways: Gemini gets the bracketed direction,
    // Edge gets the plain narration. Both speak the same words — only the
    // Gemini input carries the delivery notes, and those are never spoken.
    const directed = script.beats
      ? buildDirectedNarration(script.hook, script.beats, script.debateQuestion, directive.perBeatDelivery)
      : { styleDirection: FLAT_DIRECTION, text: script.body };

    const ttsRunId = await startRun(env.db, "tts", traceId);
    const ttsResult = await synthesizeWithFallback(
      selection,
      { text: directed.text, voice: HOST_GEMINI_VOICE, styleDirection: directed.styleDirection },
      { text: script.body, voice, rate },
    );
    if (!ttsResult.ok) {
      await finishRun(env.db, ttsRunId, "failed", ttsResult.error.kind);
      throw new Error(`TTS failed: ${ttsResult.error.message}`);
    }
    await finishRun(env.db, ttsRunId, "succeeded");
    const tts = ttsResult.value;
    const narrationAudioPath = join(workDir, tts.response.mimeType === "audio/wav" ? "narration.wav" : "narration.mp3");
    await writeFile(narrationAudioPath, tts.response.audio);

    // ---- ALIGN (Gemini path only) ----
    // Edge TTS emits WordBoundary natively, so its timings are exact and
    // cost nothing. Gemini returns audio and no timings at all, which is
    // why this stage exists: without it, switching narration providers
    // would silently delete the word-level captions (plan v2 §4).
    let wordTimings = tts.response.wordTimings;
    let alignMatchRatio: number | null = null;
    if (wordTimings.length === 0) {
      const alignRunId = await startRun(env.db, "align", traceId);
      const asr = new GroqWhisperDriver({ apiKey: env.groqApiKey });
      const transcript = await asr.transcribe({
        wordTimestamps: true,
        source: { kind: "audio", bytes: tts.response.audio, mimeType: tts.response.mimeType },
      });
      if (!transcript.ok) {
        await finishRun(env.db, alignRunId, "failed", transcript.error.kind);
        throw new Error(`ALIGN failed: ${transcript.error.message}`);
      }
      const ranges = script.beats ? beatWordRanges({ hook: script.hook, beats: script.beats, open_question: script.debateQuestion }) : [];
      const aligned = alignBeats(transcript.value.words, script.body, ranges);
      if (!aligned.ok) {
        await finishRun(env.db, alignRunId, "failed", aligned.error.kind);
        throw new Error(`ALIGN failed: ${aligned.error.message}`);
      }
      await finishRun(env.db, alignRunId, "succeeded");
      wordTimings = aligned.value.wordTimings;
      alignMatchRatio = aligned.value.matchRatio;
      console.warn(`ALIGN: matched ${(alignMatchRatio * 100).toFixed(0)}% of the script across ${aligned.value.beatBoundaries.length} beat(s).`);
    }

    const captionCues = buildCaptionCues(wordTimings, 3, extractKeywords({ hook: script.hook, body: script.body, debateQuestion: script.debateQuestion }));

    // ---- RENDER ----
    // The host, if she is in this checkout. A missing asset degrades the
    // video to v1's look rather than failing the render — but it is
    // recorded, because "why is she not in this one" is not answerable from
    // the video itself.
    const character = await resolveCharacterOverlay(REPO_DIR);
    if (!character.present) console.warn(`RENDER: ${character.reason}`);

    const renderRunId = await startRun(env.db, "render", traceId);
    const renderDriver = new FfmpegRenderDriver();
    const renderResult = await renderDriver.compose({
      footageClipPath,
      narrationAudioPath,
      captionCues,
      outputPath,
      ...(character.present ? { characterOverlay: character.overlay } : {}),
    });
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
      targetDurationS: script.targetDurationS,
      narration: {
        driver: tts.driver,
        voice: tts.driver === "gemini-tts" ? HOST_GEMINI_VOICE : voice,
        rate: tts.driver === "gemini-tts" ? null : rate,
        styleDirection: tts.driver === "gemini-tts" ? directed.styleDirection : null,
        fallbackReason: tts.fallbackReason,
        alignMatchRatio,
      },
      characterAbsentReason: character.present ? null : character.reason,
      originalityScore: critic.originalityScore,
      minOriginalityScore: directive.minOriginalityScore,
      policyFlags: critic.policyFlags,
      footage,
      research: toResearchProvenance(research),
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
        ttsDriver: tts.driver,
        ttsVoice: tts.driver === "gemini-tts" ? HOST_GEMINI_VOICE : voice,
        durationS: renderResult.value.durationS,
        status: "rendered",
        auditResult: JSON.stringify(auditResult),
        createdAt: nowIso,
      })
      .run();

    // ---- EXPORT ----
    const exportRunId = await startRun(env.db, "export", traceId);
    const fileBytes = await readFile(outputPath);
    const exportDriver = env.exportDriver;
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
