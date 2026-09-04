#!/usr/bin/env node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desc, eq, gte, inArray } from "drizzle-orm";
import { execAtomic } from "../../db/client.ts";
import { renders, runs, scripts, signals } from "../../db/schema.ts";
import { finishRun, PIPELINE_STAGE, reapStaleRuns, startRun } from "../../db/runs.ts";
import { reapExpiredExports } from "../../db/exports-reap.ts";
import { claimNextRunPick, retireStrandedPicks } from "../../db/run-picks.ts";
import { isPipelineEnabled } from "../../src/server/console/killswitch.ts";
import { getSettings } from "../../src/server/console/settings.ts";
import { DEFAULT_DIRECTIVE, DEFAULT_TARGET_DURATION_S } from "../../src/server/console/directive-schema.ts";
import { checkAndAlert } from "../../src/server/alerts/rules.ts";
import { pickVoicesForToday, weightSourcesForToday } from "../../src/lib/pipeline/diversity.ts";
import { generateDiscourseScript } from "../../src/lib/pipeline/script.ts";
import { beatWordRanges } from "../../src/lib/pipeline/discourse.ts";
import { buildDirectedNarration } from "../../src/lib/pipeline/tts-direction.ts";
import { selectTtsDrivers, synthesizeWithFallback } from "../../src/lib/pipeline/tts-select.ts";
import { readGeminiTtsBudget, recordGeminiTtsAttempt, settleGeminiTtsAttempt } from "../../src/lib/pipeline/tts-budget.ts";
import { CHARACTER_BOTTOM_MARGIN_RATIO, CHARACTER_HEIGHT_RATIO, HOST_GEMINI_VOICE, resolveCharacterPack } from "../../src/lib/pipeline/character.ts";
import { buildCharacterTimeline } from "../../src/lib/pipeline/character-timeline.ts";
import { FfmpegCharacterOverlayDriver } from "../../src/lib/drivers/character-overlay-ffmpeg.ts";
import { extractKeywords } from "../../src/lib/pipeline/keywords.ts";
import { type ResearchBrief } from "../../src/lib/rag/research.ts";
import { researchWithFallback, selectResearchProviders } from "../../src/lib/rag/research-provider.ts";
import { saveResearchBrief } from "../../src/lib/rag/research-store.ts";
import { SignalsBm25Retriever } from "../../src/lib/rag/retriever.ts";
import { critiqueScript, markCritiquedWithoutVerdict } from "../../src/lib/pipeline/critic.ts";
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
import { createEditLadder, createReasoningLadders } from "../../src/lib/drivers/resolve-ladder.ts";
import type { LadderUse } from "../../src/lib/drivers/llm-ladder.ts";
import { GEMINI_RESEARCH_MODEL, GROQ_LIGHT_MODEL, GROQ_REASONING_MODEL } from "../../src/config/models.ts";
import { RerankingRetriever } from "../../src/lib/rag/rerank.ts";
import { editClips, type EditableClip } from "../../src/lib/pipeline/edit.ts";
import { generateUploadMetadata } from "../../src/lib/pipeline/upload-metadata.ts";
import { buildPipelineEnv, type PipelineEnv } from "./env.ts";

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
 * had. The invocation gets one too (`PIPELINE_STAGE`), open for as long as
 * it runs: stage rows alone cannot tell "between two stages" from
 * "finished", and the console believed the second one.
 */
async function main(): Promise<void> {
  const env = buildPipelineEnv();
  // A previous run killed by the Actions job timeout leaves its row
  // `running` forever, which the console then reports as a live stage.
  // Swept here rather than in the console: this is a write, and the
  // pipeline owns the runs table.
  const reaped = await reapStaleRuns(env.db);
  if (reaped > 0) console.warn(`Reaped ${reaped} abandoned run row(s) left behind by a killed job.`);

  // A render that failed or was killed leaves its run pick `claimed`
  // forever. Those picks are cancelled, never put back on the queue
  // (operator direction 2026-09-03 — db/run-picks.ts says why the earlier
  // requeue was worse than the loss it was fixing).
  //
  // Runs alive right now, AFTER the reaper above has failed the abandoned
  // ones, are the only traces whose picks are genuinely being worked on.
  const liveTraces = [...new Set((await env.db.select().from(runs).where(eq(runs.status, "running")).all()).map((row) => row.traceId))];
  const retiredPicks = await retireStrandedPicks(env.db, liveTraces);
  if (retiredPicks > 0) console.warn(`Cancelled ${retiredPicks} run pick(s) left behind by a render that failed or was killed.`);

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

  /**
   * The invocation's own row, open for exactly as long as this invocation
   * is (db/runs.ts's PIPELINE_STAGE says why it has to exist).
   *
   * Opened before the first stage and closed after the last one, including
   * on the paths that produce nothing and on the throw — so there is no
   * moment in a live run where every row this trace has written is closed
   * and the console can mistake a gap between two stages for the end.
   */
  const lifecycleRunId = await startRun(env.db, PIPELINE_STAGE, traceId);
  let outcome: InvocationOutcome;
  try {
    outcome = await renderOneVideo(env, traceId);
  } catch (error) {
    // Closed before the rethrow, never in a `finally` that would also run on
    // the success path: the row has to carry *why*, and the message is what
    // names the cause when the failure happened between two stages and no
    // stage row is holding it (`PLAN produced no shots`, and every throw
    // like it). Truncated because `error_class` is read on screen.
    await finishRun(env.db, lifecycleRunId, "failed", (error instanceof Error ? error.message : String(error)).slice(0, 200));
    throw error;
  }
  await finishRun(env.db, lifecycleRunId, outcome.kind === "skipped" ? "skipped" : "succeeded", outcome.kind === "skipped" ? outcome.reason : undefined);

  if (env.discordWebhookUrl) {
    await checkAndAlert(env.db, env.discordWebhookUrl);
  }
}

/**
 * What one invocation did, as its lifecycle row records it.
 *
 * `skipped` is a real outcome and not a failure — the killswitch is off, or
 * WATCH has not scored anything yet — and saying so in the row is what stops
 * the console from waiting on a run that was never going to make anything.
 */
type InvocationOutcome = { kind: "rendered" } | { kind: "skipped"; reason: string };

/** One signal, end to end: RESEARCH through EXPORT. Its caller owns the lifecycle row and the sweeps. */
async function renderOneVideo(env: PipelineEnv, traceId: string): Promise<InvocationOutcome> {
  if (!(await isPipelineEnabled(env.hotKv))) {
    console.warn("Pipeline killswitch is off — skipping this RENDER run.");
    return { kind: "skipped", reason: "killswitch_off" };
  }

  const scoredSignals = await env.db.select().from(signals).where(eq(signals.state, "scored")).all();
  if (scoredSignals.length === 0) {
    console.warn("RENDER: no scored signals available — nothing to do this cycle.");
    return { kind: "skipped", reason: "no_scored_signals" };
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
  // list this system ranked for them.
  //
  // `PIPELINE_PLAN_ID` binds the invocation to one plan — the console sets
  // it to the plan the operator submitted seconds before the dispatch — and
  // an unset one is the scheduled or hand-triggered case, which reads the
  // queue and then falls back to the weighting, as it always has.
  const planId = process.env.PIPELINE_PLAN_ID?.trim() || null;
  const claimedPick = await claimNextRunPick(env.db, traceId, new Date().toISOString(), planId);

  // A scoped run whose plan has nothing left to claim makes NOTHING
  // (operator direction 2026-09-03). The fallback below would otherwise
  // render the diversity-weighted signal — a story chosen by no one, paid
  // for out of a daily token budget that holds about two renders. This is
  // the ordinary end of a two-video run's third invocation and of a plan
  // the operator cancelled, so it is `skipped`, not a failure. Nothing has
  // been spent at this point: the claim is the first thing in the stage.
  if (planId !== null && claimedPick === null) {
    console.warn(`RUN PLAN ${planId} has no queued pick left to claim — this invocation makes nothing.`);
    return { kind: "skipped", reason: "plan_exhausted" };
  }

  const pickedSignal = claimedPick === null ? undefined : scoredSignals.find((s) => s.id === claimedPick.signalId);
  if (claimedPick !== null && pickedSignal === undefined) {
    // The claim succeeded (the signal was `scored` inside that statement)
    // but it is not in this run's candidate list — the two reads are
    // seconds apart and WATCH runs on its own schedule.
    //
    // Scoped, that is the end of the invocation: the operator asked for
    // this story and the weighted fallback is not a smaller version of it,
    // it is a different video. Unscoped, the fallback is the whole point.
    if (planId !== null) {
      console.warn(`RUN PICK ${claimedPick.id} named signal ${claimedPick.signalId}, which is no longer among the scored candidates — this invocation makes nothing.`);
      return { kind: "skipped", reason: "pick_signal_gone" };
    }
    console.warn(`RUN PICK ${claimedPick.id} named signal ${claimedPick.signalId}, which is no longer among the scored candidates — falling back to the weighted pick.`);
  }
  const chosenSignal = pickedSignal ?? weightedPick;
  if (pickedSignal !== undefined) console.warn(`RUN PICK: rendering the operator's queued ${claimedPick?.topic} pick — ${pickedSignal.title}`);

  // One driver for every Groq stage, but no longer one model: SCRIPT, PLAN,
  // EDIT and RESEARCH's fallback are on gpt-oss-120b, while CRITIC and
  // EXPORT's listing moved to gpt-oss-20b on 2026-09-03 (operator
  // direction). Each stage names its own from src/config/models.ts, which is
  // the only file that may spell a model id — a stage that names one inline
  // drifts silently, which is exactly what CRITIC did until this change.
  //
  // The single limiter matters as much as the single model. It is the
  // account's pacing, shared by every stage below, so RESEARCH's tool loop
  // and SCRIPT's draft queue behind one token bucket instead of racing each
  // other into a 429.
  const llm = createGroqDriverFromEnv(env.groqApiKey, createGroqLimiter());

  // Every reasoning stage is a ladder since 2026-09-04 (operator direction):
  // Gemini Flash Lite, then gpt-oss-120b, then gpt-oss-20b, each rung tried
  // only when the one above it errored. One ladder per stage, over one set
  // of drivers — the stickiness has to be per stage so a rate-limited rerank
  // does not decide where SCRIPT starts, and the drivers have to be shared
  // because the rate limits are per account and per model. CRITIC and
  // EXPORT's listing are the two stages with no ladder at all: they are on
  // gpt-oss-20b outright and both already fail soft.
  const ladders = createReasoningLadders(llm, env.geminiApiKey);
  if (ladders.geminiUnavailableReason !== null) console.warn(`REASONING: ${ladders.geminiUnavailableReason}`);
  const rerankLadder = ladders.forStage("RERANK");
  const scriptLadder = ladders.forStage("SCRIPT");
  const planLadder = ladders.forStage("PLAN");
  // EDIT's ladder is its own pair of models on their own daily allowance —
  // qwen3.8-27b, then qwen3.6-27b for the rest of the run. No Gemini rung: a
  // tool loop of ~34 turns cannot live inside 5 requests a minute.
  const editLadder = createEditLadder(llm);

  /**
   * What a stage actually ran on, for the audit package.
   *
   * Read from the ladder immediately after the stage, never assumed: the
   * whole point of the arrangement is that the answer differs between
   * renders, and a hard-coded model id here would be the same silent drift
   * CRITIC had until 2026-09-03.
   *
   * A null `lastUsed()` means no rung ever returned a completion — either
   * the stage made no model call at all (reranking skips one under three
   * candidates) or every rung failed and the stage took its degrade path.
   * Both are recorded as exactly that rather than as a model that spoke.
   */
  const stageRan = (stage: string, ladder: { lastUsed(): LadderUse | null }, fallbackReason: string | null = null) => {
    const used = ladder.lastUsed();
    return used === null
      ? {
          stage,
          provider: "groq" as const,
          model: GROQ_REASONING_MODEL,
          fallbackReason: fallbackReason ?? "no model answered — the stage either made no call or fell through every rung to its degrade path",
        }
      : { stage, provider: used.provider, model: used.model, fallbackReason: fallbackReason ?? used.fallbackReason };
  };

  // ---- RESEARCH (RAG: BM25 retrieval + live source reads, driven by tool-calling) ----
  // Deliberately not fatal. A retrieval outage, a rate limit, or a model
  // that cannot produce a citable brief costs this render its grounding and
  // nothing else — SCRIPT falls back to writing from the signal title, and
  // AUDIT SUMMARY flags the result as ungrounded so the reviewer knows
  // which kind of script they are reading. Losing the day's video to a
  // failed research call would be a strictly worse trade.
  const researchRunId = await startRun(env.db, "research", traceId);
  // BM25 finds the candidates; the model orders them (src/lib/rag/rerank.ts).
  // Reranking is wrapped around the retriever rather than built into it, so
  // a reranker outage leaves plain BM25 retrieval in place. It is on the
  // general ladder like SCRIPT and PLAN, and its Gemini rung costs RESEARCH
  // nothing: the ladder's model id is not RESEARCH's, and Gemini meters
  // requests per model, so this call never comes out of RESEARCH's four.
  const retriever = new RerankingRetriever(new SignalsBm25Retriever(env.db), rerankLadder);

  // Gemini 3.7 Flash first, Groq on any failure (operator direction,
  // 2026-09-02). Both attempts and their bounds are configured in
  // src/lib/rag/research-provider.ts; RENDER only decides that RESEARCH is
  // the stage that gets one.
  const researchProviders = selectResearchProviders(llm, env.geminiApiKey);
  if (researchProviders.unavailableReason !== null) console.warn(`RESEARCH: ${researchProviders.unavailableReason}`);
  const researchOutcome = await researchWithFallback(researchProviders, retriever, chosenSignal);
  const researchResult = researchOutcome.result;
  let research: ResearchBrief | null = null;
  if (researchResult.ok) {
    research = researchResult.value;
    await saveResearchBrief(env.db, chosenSignal.id, research);
    await finishRun(env.db, researchRunId, "succeeded");
    console.warn(
      `RESEARCH: ${research.citations.length} citation(s) from ${research.toolCallsMade.length} tool call(s) on ${researchOutcome.provider} (${research.model})` +
        `${research.toolResultsDropped > 0 ? `, ${research.toolResultsDropped} tool result(s) dropped to fit the request ceiling` : ""}.`,
    );
  } else {
    await finishRun(env.db, researchRunId, "degraded", `${researchResult.error.kind}: ${researchResult.error.message}`);
    console.warn(`RESEARCH failed (${researchResult.error.kind}: ${researchResult.error.message}) — continuing ungrounded.`);
  }

  // ---- SCRIPT (v2 discourse format: beats with a `move`, plan v2 §4) ----
  const targetDurationS = directive.targetDurationS ?? DEFAULT_TARGET_DURATION_S;
  const scriptRunId = await startRun(env.db, "script", traceId);
  const scriptResult = await generateDiscourseScript(env.rawClient, chosenSignal, scriptLadder, targetDurationS, research, Date.now, undefined, traceId, GROQ_REASONING_MODEL);
  if (!scriptResult.ok) {
    await finishRun(env.db, scriptRunId, "failed", scriptResult.error.kind);
    throw new Error(`SCRIPT failed: ${scriptResult.error.message}`);
  }
  await finishRun(env.db, scriptRunId, "succeeded");
  const script = scriptResult.value;
  // Accepted, not hidden. The gate no longer fails a render over a length
  // estimate (src/lib/pipeline/discourse.ts), so the miss has to be visible
  // somewhere the operator will see it — the render log here, and AUDIT
  // SUMMARY's word-count flag on the review surface.
  for (const note of script.structureNotes) console.warn(`SCRIPT: accepted with an advisory note — ${note}`);
  console.warn(
    `SCRIPT: performance roll — format "${script.performance.format.id}", ` +
      `${script.performance.opening.tone}/${script.performance.opening.pace} -> ${script.performance.middle.tone} -> ${script.performance.closing.tone}/${script.performance.closing.pace}, ` +
      `cues [${script.performance.nonVerbal.join(", ")}] x~${script.performance.cueTarget}` +
      `${script.performance.stylistic === null ? "" : `, character "${script.performance.stylistic}"`}.`,
  );

  // ---- CRITIC ----
  //
  // Advisory, and now actually treated that way. Its verdict gates nothing —
  // it is carried into the audit package for a human to weigh (§5.4) — so a
  // critic that cannot be reached costs the render its second opinion and
  // nothing else. On 2026-09-03 a run with a finished script and a finished
  // RESEARCH brief was thrown away by `CRITIC failed: HTTP 429`, which is
  // the same contract RESEARCH, PLAN, EDIT and HOST already have, missing
  // from the one stage every document calls advisory.
  const criticRunId = await startRun(env.db, "critic", traceId);
  const criticResult = await critiqueScript(env.rawClient, script, chosenSignal, llm);
  let criticDegradedReason: string | null = null;
  if (criticResult.ok) {
    await finishRun(env.db, criticRunId, "succeeded");
  } else {
    criticDegradedReason = `${criticResult.error.kind}: ${criticResult.error.message}`;
    await finishRun(env.db, criticRunId, "degraded", criticResult.error.kind);
    // The signal still has to leave `scripted`; only the verdict is missing.
    await markCritiquedWithoutVerdict(env.rawClient, chosenSignal.id);
    console.warn(`CRITIC failed (${criticDegradedReason}) — continuing with no originality score.`);
  }
  const critic = criticResult.ok ? criticResult.value : null;

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
  const planInput = {
    hook: script.hook,
    beats: script.beats,
    body: script.body,
    debateQuestion: script.debateQuestion,
    topic: claimedPick?.topic ?? null,
  };
  const planResult = await planShots(planLadder, planInput, { model: GROQ_REASONING_MODEL });
  // planShots never returns an error — the worst case is the heuristic plan.
  const plan = planResult.ok ? planResult.value : heuristicPlan({ hook: script.hook, beats: script.beats ?? [], body: script.body, debateQuestion: script.debateQuestion, topic: null }, "PLAN returned an error");
  await finishRun(env.db, planRunId, plan.degradedReason === null ? "succeeded" : "degraded", plan.degradedReason ?? undefined);
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
  // Two files, because the host is composited by its own pass
  // (src/lib/drivers/character-overlay-ffmpeg.ts). `renderPath` is the
  // finished video — footage, narration, captions, no host — and it is what
  // gets exported if the overlay pass cannot run.
  const renderPath = join(workDir, `${script.id}.render.mp4`);
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
      // Decides how many YouTube downloads this render may make: 4 for
      // politics/tech/science/ai, where the real recorded thing exists and
      // is the point; 2 otherwise (src/lib/footage/source-agent.ts).
      topic: claimedPick?.topic ?? null,
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

    // How many Gemini TTS *requests* this pipeline has already sent on the
    // current Pacific day — the day Google's free-tier counter resets on,
    // and every request rather than every successful render. Counting
    // `renders` rows against a UTC day (what this used to do) read zero at
    // 21:00 PT on 2026-09-02 while all ten were gone, and the operator got
    // Edge TTS where they had asked for Kore. See tts-budget.ts.
    const geminiBudget = await readGeminiTtsBudget(env.hotKv);
    const selection = selectTtsDrivers(env.geminiApiKey, geminiBudget);
    if (selection.unavailableReason !== null) console.warn(`TTS: ${selection.unavailableReason}`);
    else console.warn(`TTS: Gemini narration available — ${geminiBudget.spent}/${geminiBudget.budget} requests spent on ${geminiBudget.day} (Pacific).`);

    // The beats reach TTS two ways, and the asymmetry is the whole design.
    // Gemini gets the writer's inline delivery tags — the laughs, the sighs,
    // the tone changes this video was rolled for — because it is the only
    // driver that performs them. Edge gets `script.body`, which is the same
    // words with every tag stripped by `flattenBeats`. That is also the
    // string the captions are built from, so a tag cannot reach the screen
    // even if the writer puts one somewhere strange (delivery-tags.ts).
    const directed = buildDirectedNarration(script.narration.hook, script.narration.beats, script.narration.openQuestion, directive.perBeatDelivery ?? false, script.performance);

    const ttsRunId = await startRun(env.db, "tts", traceId);
    const ttsResult = await synthesizeWithFallback(
      selection,
      { text: directed.text, voice: HOST_GEMINI_VOICE, styleDirection: directed.styleDirection },
      { text: script.body, voice, rate },
      console.warn,
      {
        record: () => recordGeminiTtsAttempt(env.hotKv, traceId),
        settle: (outcome, reason) => settleGeminiTtsAttempt(env.hotKv, outcome, reason),
      },
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

    const beatRanges = beatWordRanges({ hook: script.hook, beats: script.beats, open_question: script.debateQuestion });

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
        await finishRun(env.db, alignRunId, "degraded", align.failure.errorClass);
        console.warn(
          `ALIGN failed (${align.failure.errorClass}: ${align.failure.message}) — continuing with caption timings estimated across ${(narrationDurationMs / 1000).toFixed(1)}s of narration.`,
        );
      }
    }
    const { wordTimings, alignMatchRatio, captionTiming } = align;

    const captionCues = buildCaptionCues(wordTimings, 3, extractKeywords({ hook: script.hook, body: script.body, debateQuestion: script.debateQuestion }));

    // ---- RENDER ----
    //
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

    // ---- EDIT (the model driving Kinocut over MCP) ----
    //
    // Runs here rather than straight after SOURCE because it needs each
    // clip's on-screen duration, and that is not known until the narration
    // has been timed. Never fatal at any granularity: a clip whose edit
    // fails keeps its sourced bytes, and a stage that cannot start at all
    // returns every clip untouched. Either way the render continues and
    // produces the video it would have produced before this stage existed.
    const editRunId = await startRun(env.db, "edit", traceId);
    const editableClips: EditableClip[] = timeline.map((slot) => {
      const shot = shotAt(slot.position);
      return { position: slot.position, filePath: shot.filePath, durationS: slot.durationS, intent: shot.intent, query: shot.query, provider: shot.provider };
    });
    const editResult = await editClips(editableClips, { llm: editLadder, workDir });
    // editClips never returns an error — the worst case is every clip unedited.
    const edits = editResult.ok ? editResult.value : { clips: editableClips.map((clip) => ({ position: clip.position, filePath: clip.filePath, edited: false, toolsRun: [], skippedReason: "EDIT returned an error" })), degradedReason: "EDIT returned an error", model: null };
    const editedCount = edits.clips.filter((clip) => clip.edited).length;
    await finishRun(env.db, editRunId, edits.degradedReason === null ? "succeeded" : "degraded", edits.degradedReason ?? undefined);
    console.warn(`EDIT: ${editedCount}/${edits.clips.length} clip(s) edited${edits.degradedReason === null ? "" : ` — degraded: ${edits.degradedReason}`}`);

    const editedPathAt = (position: number): string => edits.clips.find((clip) => clip.position === position)?.filePath ?? shotAt(position).filePath;

    const footageClips = timeline.map((slot) => ({ filePath: editedPathAt(slot.position), durationS: slot.durationS }));

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
        // The window of the source, not of the output — the pair above is
        // the output. Both are needed for "which videos are in this, and
        // which part of each".
        sourceStartS: shot.sourceStartS,
        sourceEndS: shot.sourceEndS,
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
      outputPath: renderPath,
      outputDurationS: narrationDurationMs / 1000,
    });
    if (!renderResult.ok) {
      await finishRun(env.db, renderRunId, "failed", renderResult.error.kind);
      throw new Error(`RENDER failed: ${renderResult.error.message}`);
    }
    await finishRun(env.db, renderRunId, "succeeded");

    // ---- HOST ----
    //
    // A second ffmpeg pass over the finished video (operator direction,
    // 2026-09-03). No model chose any of this: the host waves hello, runs
    // every other action in the pack in manifest order on a loop, and waves
    // goodbye, for exactly as long as the video lasts.
    //
    // **Never fatal, at either level.** A missing or unreadable pack, or an
    // encoder that cannot composite, leaves `renderPath` — a complete,
    // publishable Short with footage, narration and captions and no host —
    // and the reason reaches the audit package. The same contract RESEARCH
    // and EDIT have, and the reason this is a separate pass at all: inside
    // the render's filtergraph the identical failure took the video with it.
    const character = await resolveCharacterPack(REPO_DIR);
    if (!character.present) console.warn(`HOST: ${character.reason}`);

    const characterTrack = character.present
      ? buildCharacterTimeline({ pack: character.pack, videoDurationS: renderResult.value.durationS })
      : { clips: [], trackDurationS: 0 };

    // The finished file, whichever pass produced it. Reassigned only when the
    // overlay actually succeeds, so every failure path below leaves EXPORT
    // pointing at the hostless render rather than at a file that may not
    // exist.
    let finishedPath = renderPath;
    let hostAbsentReason = character.present ? null : character.reason;

    if (character.present && characterTrack.clips.length === 0) {
      // Only reachable from a video with no measurable duration, which would
      // be a broken render — but an absent host with no reason beside it is
      // the one thing the audit package is not allowed to contain.
      hostAbsentReason = `the host track came out empty for a ${renderResult.value.durationS}s video — published as footage and captions only.`;
      console.warn(`HOST: ${hostAbsentReason}`);
    }

    if (characterTrack.clips.length > 0) {
      const hostRunId = await startRun(env.db, "host", traceId);
      const overlayResult = await new FfmpegCharacterOverlayDriver().composite({
        videoPath: renderPath,
        overlay: { clips: characterTrack.clips, heightRatio: CHARACTER_HEIGHT_RATIO, bottomMarginRatio: CHARACTER_BOTTOM_MARGIN_RATIO },
        outputPath,
        durationS: renderResult.value.durationS,
      });
      if (overlayResult.ok) {
        finishedPath = outputPath;
        await finishRun(env.db, hostRunId, "succeeded");
        console.warn(`HOST: ${characterTrack.clips.length} action(s), ${characterTrack.trackDurationS.toFixed(1)}s over a ${renderResult.value.durationS.toFixed(1)}s video.`);
      } else {
        hostAbsentReason = `the host overlay pass failed (${overlayResult.error.kind}: ${overlayResult.error.message}) — published as footage and captions only.`;
        await finishRun(env.db, hostRunId, "degraded", overlayResult.error.kind);
        console.warn(`HOST: ${hostAbsentReason}`);
      }
    }
    const hostOnScreen = finishedPath === outputPath;

    // ---- AUDIT SUMMARY (deterministic, no model call, never blocks) ----
    // Excluding this render's own script, which SCRIPT inserted several
    // stages ago. Without that filter the near-duplicate check compared the
    // script against itself and reported `script similarity 1.00 >= 0.85` on
    // every export ever made — a self-repetition detector that always fires
    // is worse than none, because it teaches the operator to skip the line.
    const recentScripts = (await env.db.select().from(scripts).orderBy(desc(scripts.createdAt)).limit(101).all()).filter((row) => row.id !== script.id);
    const captionEndMs = captionCues.length > 0 ? captionCues[captionCues.length - 1].endMs : 0;
    const auditResult = computeAuditSummary({
      script: { hook: script.hook, body: script.body, debateQuestion: script.debateQuestion, wordCount: script.wordCount },
      targetDurationS: script.targetDurationS,
      performance: {
        seed: script.performance.seed,
        format: script.performance.format.id,
        arc: `${script.performance.opening.tone}/${script.performance.opening.pace} -> ${script.performance.middle.tone} -> ${script.performance.closing.tone}/${script.performance.closing.pace}`,
        nonVerbal: script.performance.nonVerbal,
        cueTarget: script.performance.cueTarget,
        stylistic: script.performance.stylistic,
        // Only Gemini performs the inline tags. On Edge the script's laughs
        // and sighs are stripped along with every other tag and simply are
        // not in the audio.
        deliveryApplied: tts.driver === "gemini-tts",
      },
      narration: {
        driver: tts.driver,
        voice: tts.driver === "gemini-tts" ? HOST_GEMINI_VOICE : voice,
        rate: tts.driver === "gemini-tts" ? null : rate,
        styleDirection: tts.driver === "gemini-tts" ? directed.styleDirection : null,
        fallbackReason: tts.fallbackReason,
        alignMatchRatio,
        captionTiming,
      },
      characterAbsentReason: hostAbsentReason,
      // Recorded only when the host is genuinely in the file. A sequence
      // beside a `characterAbsentReason` would describe a performance no
      // frame of the export contains.
      character:
        hostOnScreen && character.present
          ? {
              pack: character.pack.pack,
              packVersion: character.pack.version,
              sequence: characterTrack.clips.map((clip) => clip.actionId),
              trackDurationS: characterTrack.trackDurationS,
            }
          : null,
      edit: { model: edits.model, degradedReason: edits.degradedReason, clips: edits.clips.map(({ position, edited, toolsRun, skippedReason }) => ({ position, edited, toolsRun, skippedReason })) },
      // Which provider and model actually answered each reasoning stage, and
      // why it was not the preferred one.
      //
      // Every line but CRITIC's is now read back off the thing that made the
      // call rather than written down here. Since 2026-09-04 each of these
      // stages is a ladder that steps down on any failure, so two renders an
      // hour apart can legitimately have been written by different models —
      // which makes this block the only place a reviewer can find out that
      // today's script came from the small model because the other two were
      // rate-limited.
      stages: [
        // The model its brief recorded, not the one it was handed — that is
        // the one whose citations a reviewer is checking. A failed stage has
        // no brief to ask, so the provider asked last is the honest answer.
        {
          stage: "RESEARCH",
          provider: researchOutcome.provider,
          model: research?.model ?? (researchOutcome.provider === "gemini" ? GEMINI_RESEARCH_MODEL : GROQ_REASONING_MODEL),
          fallbackReason: researchOutcome.fallbackReason,
        },
        stageRan("RERANK", rerankLadder),
        stageRan("SCRIPT", scriptLadder),
        // The one stage with no ladder to read, and the one line still
        // written by hand. On the lighter model since 2026-09-03, and
        // recorded for that reason: CRITIC's originality score is the one
        // number in the audit package a reviewer weighs against the script
        // itself, and "which model graded this" is not recoverable from the
        // score. It is also no longer the model that wrote the script, which
        // is the whole point of moving it (src/config/models.ts).
        { stage: "CRITIC", provider: "groq" as const, model: GROQ_LIGHT_MODEL, fallbackReason: criticDegradedReason },
        stageRan("PLAN", planLadder),
        // EDIT names its models in `edit.model` as well, because that is the
        // field the Metadata sheet reads; this line is what makes it
        // answerable in the same place as the others.
        stageRan("EDIT", editLadder, edits.degradedReason),
      ],
      originalityScore: critic?.originalityScore ?? null,
      minOriginalityScore: directive.minOriginalityScore,
      policyFlags: critic?.policyFlags ?? [],
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
    //
    // The listing the operator pastes into YouTube Studio. One model call,
    // never fatal: a failure degrades to a listing derived from the script
    // itself and says so, which is strictly better than what shipped before
    // this stage existed — a title that was the first 100 characters of the
    // narration, a description that was its first 500 cut off mid-word, and
    // no hashtags at all.
    const uploadMetadata = await generateUploadMetadata(llm, {
      hook: script.hook,
      body: script.body,
      debateQuestion: script.debateQuestion,
      topic: claimedPick?.topic ?? null,
    });
    if (uploadMetadata.degradedReason !== null) console.warn(`METADATA: ${uploadMetadata.degradedReason}`);
    console.warn(`METADATA: "${uploadMetadata.title}" · ${uploadMetadata.hashtags.length} hashtag(s)`);

    const exportRunId = await startRun(env.db, "export", traceId);
    // `finishedPath`, never `outputPath`: they are the same file only when
    // the overlay pass ran. Exporting `outputPath` unconditionally would read
    // a file that does not exist on every degraded-host render.
    const fileBytes = await readFile(finishedPath);
    const exportDriver = env.exportDriver;
    const exportResult = await runExport(
      env.db,
      finishedPath,
      fileBytes,
      {
        renderId,
        script: { hook: script.hook, body: script.body, debateQuestion: script.debateQuestion },
        critic: critic === null ? null : { originalityScore: critic.originalityScore, policyFlags: critic.policyFlags, verdict: critic.verdict, reason: critic.reason },
        footage,
        // What actually spoke, not what was selected before the driver was
        // chosen — the same source `auditResult.narration` reads from.
        ttsSettings:
          tts.driver === "gemini-tts"
            ? { voice: HOST_GEMINI_VOICE, rate: null, pitch: null, volume: null }
            : { voice, rate, pitch: "+0Hz", volume: "+0%" },
        auditResult,
        suggestedTitle: uploadMetadata.title,
        suggestedDescription: uploadMetadata.description,
        suggestedTags: uploadMetadata.hashtags,
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

  return { kind: "rendered" };
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
