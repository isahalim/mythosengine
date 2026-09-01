#!/usr/bin/env node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desc, eq, gte, inArray } from "drizzle-orm";
import { execAtomic } from "../../db/client.ts";
import { renders, runs, scripts, signals } from "../../db/schema.ts";
import { finishRun, reapStaleRuns, startRun } from "../../db/runs.ts";
import { reapExpiredExports } from "../../db/exports-reap.ts";
import { claimNextRunPick, releaseStrandedPicks } from "../../db/run-picks.ts";
import { isPipelineEnabled } from "../../src/server/console/killswitch.ts";
import { getSettings } from "../../src/server/console/settings.ts";
import { DEFAULT_DIRECTIVE, DEFAULT_TARGET_DURATION_S } from "../../src/server/console/directive-schema.ts";
import { checkAndAlert } from "../../src/server/alerts/rules.ts";
import { pickVoicesForToday, weightSourcesForToday } from "../../src/lib/pipeline/diversity.ts";
import { generateDiscourseScript } from "../../src/lib/pipeline/script.ts";
import { beatWordRanges } from "../../src/lib/pipeline/discourse.ts";
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
import { computeAuditSummary, type FootagePart, type FootageProvenance, type ResearchProvenance } from "../../src/lib/pipeline/audit.ts";
import { runExport } from "../../src/lib/pipeline/export.ts";
import { sourceShots, type SourcedShot } from "../../src/lib/footage/source-agent.ts";
import { sweepSourceCache } from "../../src/lib/footage/source-cache.ts";
import { heuristicPlan, planShots } from "../../src/lib/pipeline/shot-plan.ts";
import { advanceShot, reapAbandonedShots, saveShotPlan } from "../../db/shot-plans.ts";
import { DomYoutubeSearchDriver } from "../../src/lib/drivers/youtube-search-dom.ts";
import { buildDownloadDriver } from "../../src/lib/footage/download-route.ts";
import { buildMontageTimeline } from "../../src/lib/pipeline/montage-timeline.ts";
import { resolveWordTimings } from "../../src/lib/pipeline/align-stage.ts";
import { probeDurationS } from "../../src/lib/drivers/probe-video.ts";
import { PexelsDriver } from "../../src/lib/drivers/pexels.ts";
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

  // A render killed mid-flight leaves its run pick `claimed` forever, and
  // the operator's queued story then silently never gets made — the next run
  // finds an empty queue and falls back to its own diversity-weighted
  // choice, producing a video about something nobody asked for. Observed the
  // first time a viral render was killed mid-download (2026-09-01).
  //
  // Runs alive right now, AFTER the reaper above has failed the abandoned
  // ones, are the only traces whose picks are genuinely being worked on.
  const liveTraces = [...new Set((await env.db.select().from(runs).where(eq(runs.status, "running")).all()).map((row) => row.traceId))];
  const released = await releaseStrandedPicks(env.db, liveTraces);
  if (released > 0) console.warn(`Requeued ${released} run pick(s) stranded by a killed render.`);

  // Same class of leftover, third door: a killed render leaves its shot rows
  // mid-flight and stage 5 shows them as `downloading` forever.
  const abandonedShots = await reapAbandonedShots(env.db, liveTraces, new Date().toISOString());
  if (abandonedShots > 0) console.warn(`Marked ${abandonedShots} shot(s) abandoned by a killed render.`);

  // Export blobs live in R2 since 2026-08-31, and R2 has no per-object TTL
  // the way KV did — so the review window is enforced here rather than by
  // the store. Swept at the top of a run, like the stale-run reaper above
  // and for the same reason: this is a write, and the pipeline owns it.
  const { retired, failures, segmentsFreed } = await reapExpiredExports(env.db, async (key) => {
    const removal = await env.exportDriver.remove(key);
    return removal.ok ? { ok: true } : { ok: false, error: `${removal.error.kind}: ${removal.error.message}` };
  });
  if (retired > 0) console.warn(`Retired ${retired} export(s) past their review window and freed their blobs.`);
  if (segmentsFreed > 0) console.warn(`Dropped ${segmentsFreed} footage row(s) no reviewable video points at any more.`);

  // The 24h YouTube source cache — the only footage that outlives a render,
  // and only so a viral run does not re-pull a walkthrough hourly (operator
  // direction 2026-09-01). Swept by age here, beside the other sweeps and
  // for the same reason: this is a write, and the pipeline owns it.
  const swept = await sweepSourceCache(REPO_DIR);
  if (swept.removed > 0) console.warn(`Swept ${swept.removed} cached source(s) past 24h, freeing ${(swept.bytesFreed / 1e9).toFixed(2)} GB.`);
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
    { voicePool: directive.voicePool ?? null, preferredSourceIds: directive.preferredSourceIds, diversityMode: directive.diversityMode },
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

  // ---- PLAN ----
  //
  // What the audience sees while the narrator argues (plan v2 §8 item 4).
  // Never fatal: a failed PLAN falls back to keyword extraction and is
  // recorded as degraded, the same contract §5.2.5 gives RESEARCH.
  //
  // `viral` never reaches the model. The operator's direction (2026-09-01)
  // is that a viral video's background is always a GTA 6 walkthrough, and
  // once the topic has decided the footage there is nothing about it left
  // to decide — which second of the run to take is answered by motion
  // scoring and chance, not by language.
  const planRunId = await startRun(env.db, "plan", traceId);
  const planResult = await planShots(llm, {
    hook: script.hook,
    beats: script.beats ?? [],
    body: script.body,
    debateQuestion: script.debateQuestion,
    topic: claimedPick?.topic ?? null,
  });
  // planShots never returns an error — the worst case is the heuristic plan.
  const plan = planResult.ok ? planResult.value : heuristicPlan({ hook: script.hook, beats: script.beats ?? [], body: script.body, debateQuestion: script.debateQuestion, topic: null }, "PLAN returned an error");
  await finishRun(env.db, planRunId, plan.degradedReason === null ? "succeeded" : "failed", plan.degradedReason ?? undefined);
  console.warn(`PLAN (${plan.origin}): ${plan.shots.length} shot(s) — ${plan.shots.map((shot) => `${shot.source}:"${shot.query}"`).join(", ")}`);
  if (plan.degradedReason !== null) console.warn(`PLAN degraded: ${plan.degradedReason}`);

  // An empty plan is a PLAN failure, and it says so here rather than being
  // discovered two stages later as "no shot in the plan could be sourced" —
  // which is what happened the first time PLAN was rate-limited and the
  // heuristic fallback rejected every keyword it had (2026-09-01). Naming
  // the stage that actually failed is the difference between a five-minute
  // diagnosis and an hour of one.
  if (plan.shots.length === 0) {
    throw new Error(`PLAN produced no shots, so there is nothing to source. Reason: ${plan.degradedReason ?? "unknown"}`);
  }

  await saveShotPlan(env.rawClient, script.id, traceId, plan.shots, new Date().toISOString());

  const todaysRenders = await env.db.select().from(renders).where(gte(renders.createdAt, since)).all();

  // The work directory precedes sourcing: every clip is downloaded into it
  // and dies with the run (operator direction 2026-09-01 — no sourced
  // footage is retained). Only the 24h YouTube source cache outlives a
  // render, and no clip is ever written there.
  const workDir = await mkdtemp(join(tmpdir(), "render-"));
  // Extension assigned after TTS, from the mime type the driver actually
  // returned: Edge emits MP3, Gemini WAV. FFmpeg probes by content and would
  // decode either under either name, but a `.mp3` holding WAV is a trap for
  // the next person to open the work directory.
  const outputPath = join(workDir, `${script.id}.mp4`);

  try {
    // ---- SOURCE ----
    //
    // Executes the plan: finds each shot, downloads it, and cuts the piece
    // worth showing (src/lib/footage/source-agent.ts). Every clip gets its
    // provenance row before it reaches the encoder, and every clip's bytes
    // live in this run's work directory and nowhere else — the `finally`
    // below is what makes "no sourced footage survives" literally true.
    //
    // The shot boundaries cannot be computed until the narration exists, so
    // clips are acquired here and laid out against the beats after TTS.
    const footageRunId = await startRun(env.db, "footage_select", traceId);

    if (env.pexelsApiKey === undefined || env.pexelsApiKey.length === 0) {
      await finishRun(env.db, footageRunId, "failed", "no_pexels_key");
      throw new Error("SOURCE failed: PEXELS_API_KEY is not set. Set it in the RENDER workflow's env, or in .env.local for a local run.");
    }

    const sourced = await sourceShots(plan, {
      db: env.db,
      pexels: new PexelsDriver(env.pexelsApiKey),
      search: new DomYoutubeSearchDriver(),
      download: buildDownloadDriver("SOURCE"),
      workDir,
      repoDir: REPO_DIR,
      nowIso: new Date().toISOString(),
      scriptId: script.id,
    });
    if (!sourced.ok) {
      await finishRun(env.db, footageRunId, "failed", sourced.error.kind);
      throw new Error(`SOURCE failed: ${sourced.error.message}`);
    }
    const sourcedShots = sourced.value.shots;
    // Surfaced, never swallowed: a montage with holes is the operator's
    // business, and the shot rows carry the same reasons for stage 5.
    for (const failure of sourced.value.failures) console.warn(`SOURCE: no clip for ${failure.source} "${failure.query}" — ${failure.error}`);
    console.warn(`SOURCE: ${sourcedShots.length} clip(s) — ${sourcedShots.map((shot) => `${shot.source}:"${shot.query}"`).join(", ")}`);
    await finishRun(env.db, footageRunId, "succeeded");

    const first = sourcedShots[0];
    const primarySegmentId = first.segmentId;
    const primaryProvenance: Omit<FootageProvenance, "parts"> = {
      segmentId: first.segmentId,
      footageSourceId: first.provider === "pexels" ? "pexels-stock" : `youtube-${first.providerClipId}`,
      sourceVideoId: first.providerClipId,
      clipStartS: 0,
      clipEndS: Math.max(1, Math.ceil(first.durationS)),
      usedCount: 0,
    };

    // ---- TTS ----
    const voicesUsedToday = todaysRenders.map((r) => r.ttsVoice);
    const voice = pickVoicesForToday({ voicePool: directive.voicePool ?? null, preferredSourceIds: directive.preferredSourceIds, diversityMode: directive.diversityMode }, voicesUsedToday)[0];
    const rate = pickTtsRate(directive.ttsRateRange ?? null);

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
      ? buildDirectedNarration(script.hook, script.beats, script.debateQuestion, directive.perBeatDelivery ?? false)
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

    // The narration's real length, measured rather than assumed. Both the
    // montage's shot boundaries and the ALIGN fallback below need it, and
    // the sum of the word timings is not it — it excludes trailing silence.
    const narrationDurationResult = await probeDurationS(narrationAudioPath);
    if (!narrationDurationResult.ok) {
      throw new Error(`could not measure the narration audio: ${narrationDurationResult.error.message}`);
    }
    const narrationDurationMs = Math.round(narrationDurationResult.value * 1000);

    const beatRanges = script.beats ? beatWordRanges({ hook: script.hook, beats: script.beats, open_question: script.debateQuestion }) : [];

    // ---- ALIGN (Gemini path only) ----
    // Edge TTS emits WordBoundary natively, so its timings are exact and
    // cost nothing. Gemini returns audio and no timings at all, which is
    // why this stage exists: without it, switching narration providers
    // would silently delete the word-level captions (plan v2 §4).
    //
    // Not fatal (operator direction, 2026-09-01). It used to be, and the
    // consequence was that a complete narration, a complete script and a
    // complete footage montage were all thrown away because one
    // transcription call failed — the same bad trade §5.2.5 already refuses
    // to make for RESEARCH. A failure here now costs the render its exact
    // caption timings and nothing else: the words are spread across the
    // measured narration instead, the run row records the real error, and
    // the audit package says `captionTiming: "estimated"` so the reviewer
    // knows why the captions drift inside a sentence.
    const needsAlign = tts.response.wordTimings.length === 0;
    const alignRunId = needsAlign ? await startRun(env.db, "align", traceId) : null;
    const align = await resolveWordTimings({
      nativeTimings: tts.response.wordTimings,
      audio: tts.response.audio,
      mimeType: tts.response.mimeType,
      scriptBody: script.body,
      beatRanges,
      narrationDurationMs,
      asr: new GroqWhisperDriver({ apiKey: env.groqApiKey }),
    });
    if (alignRunId !== null) {
      if (align.failure === null) {
        await finishRun(env.db, alignRunId, "succeeded");
        console.warn(`ALIGN: matched ${((align.alignMatchRatio ?? 0) * 100).toFixed(0)}% of the script.`);
      } else {
        await finishRun(env.db, alignRunId, "failed", align.failure.errorClass);
        console.warn(
          `ALIGN failed (${align.failure.errorClass}: ${align.failure.message}) — continuing with caption timings estimated across ${(narrationDurationMs / 1000).toFixed(1)}s of narration.`,
        );
      }
    }
    const { wordTimings, alignMatchRatio, captionTiming } = align;

    const captionCues = buildCaptionCues(wordTimings, 3, extractKeywords({ hook: script.hook, body: script.body, debateQuestion: script.debateQuestion }));

    // ---- RENDER ----
    // The host, if she is in this checkout. A missing asset degrades the
    // video to v1's look rather than failing the render — but it is
    // recorded, because "why is she not in this one" is not answerable from
    // the video itself.
    const character = await resolveCharacterOverlay(REPO_DIR);
    if (!character.present) console.warn(`RENDER: ${character.reason}`);

    // The footage track, laid out across the narration on the script's own
    // beat boundaries (src/lib/pipeline/montage-timeline.ts), so the picture
    // turns where the argument does rather than on a timer.
    const timeline = buildMontageTimeline({
      parts: sourcedShots.map((shot) => ({ position: shot.position, beatIndex: shot.beatIndex })),
      wordTimings,
      beatRanges,
      narrationDurationMs,
    });

    const shotAt = (position: number): SourcedShot => {
      const shot = sourcedShots.find((candidate) => candidate.position === position);
      if (shot === undefined) throw new Error(`the timeline named position ${position}, which no sourced clip has`);
      return shot;
    };

    const footageClips = timeline.map((slot) => ({ filePath: shotAt(slot.position).filePath, durationS: slot.durationS }));

    // Every clip that will actually be composited, with the provenance the
    // export must carry and the second of the finished video it occupies.
    // This is now the only record that a frame came from anywhere: no bytes
    // are retained, so the rows are the provenance.
    const footageParts: FootagePart[] = timeline.map((slot, index) => {
      const shot = shotAt(slot.position);
      return {
        // Renumbered to the composited order: a clip dropped for being too
        // short to read leaves no hole in the record either.
        position: index,
        segmentId: shot.segmentId,
        startMs: slot.startMs,
        endMs: slot.endMs,
        provider: shot.provider,
        providerClipId: shot.providerClipId,
        photographer: shot.photographer,
        pageUrl: shot.pageUrl,
        searchQuery: shot.query,
        beatIndex: shot.beatIndex,
      };
    });

    // A shot that survived sourcing but was dropped by the timeline for
    // being too short to read never reaches the screen, and its row should
    // not claim it did.
    const composited = new Set(timeline.map((slot) => slot.position));
    const compositedAt = new Date().toISOString();
    for (const shot of sourcedShots) {
      const inVideo = composited.has(shot.position);
      // Keyed by `planPosition`, never by the composited `position`: the two
      // diverge as soon as one shot fails to source, and using the wrong one
      // marks a failed shot as composited.
      await advanceShot(
        env.db,
        script.id,
        shot.planPosition,
        inVideo ? "composited" : "failed",
        compositedAt,
        inVideo ? { footageSegmentId: shot.segmentId } : { error: "cut from the timeline — its beat was too short to hold a shot" },
      );
    }

    const footage: FootageProvenance = { ...primaryProvenance, parts: footageParts };

    const renderRunId = await startRun(env.db, "render", traceId);
    const renderDriver = new FfmpegRenderDriver();
    const renderResult = await renderDriver.compose({
      footageClips,
      narrationAudioPath,
      captionCues,
      outputPath,
      outputDurationS: narrationDurationMs / 1000,
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
        captionTiming,
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
    // The render row and the clips it is made of land together or not at
    // all (CLAUDE.md: never a multi-step mutation outside a transaction). A
    // render row whose parts failed to insert would be a video whose
    // footage nothing accounts for, which is exactly the state this system
    // is not allowed to reach.
    await execAtomic(env.rawClient, [
      {
        sql: `INSERT INTO renders (id, script_id, footage_segment_id, tts_driver, tts_voice, duration_s, status, audit_result, created_at) VALUES (?, ?, ?, ?, ?, ?, 'rendered', ?, ?)`,
        params: [
          renderId,
          script.id,
          primarySegmentId,
          tts.driver,
          tts.driver === "gemini-tts" ? HOST_GEMINI_VOICE : voice,
          renderResult.value.durationS,
          JSON.stringify(auditResult),
          nowIso,
        ],
      },
      ...footageParts.map((part) => ({
        sql: `INSERT INTO render_footage_parts (id, render_id, position, footage_segment_id, start_ms, end_ms) VALUES (?, ?, ?, ?, ?, ?)`,
        params: [crypto.randomUUID(), renderId, part.position, part.segmentId, part.startMs, part.endMs],
      })),
    ]);

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
        // What actually spoke, not what was selected before the driver was
        // chosen — the same source `auditResult.narration` reads from.
        ttsSettings:
          tts.driver === "gemini-tts"
            ? { voice: HOST_GEMINI_VOICE, rate: null, pitch: null, volume: null }
            : { voice, rate, pitch: "+0Hz", volume: "+0%" },
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
