#!/usr/bin/env node
import { getBrief, listBriefAttachments, updateBrief } from "../../db/briefs.ts";
import { finishRun, PIPELINE_STAGE, startRun } from "../../db/runs.ts";
import { prepareBrief, type PreparedBrief } from "../../src/lib/pipeline/brief-prelude.ts";
import { createVisualReader, readAttachments, type AttachmentBytes } from "../../src/lib/pipeline/brief-attachments.ts";
import { groundedResearch } from "../../src/lib/rag/langchain-research.ts";
import { BriefBlobDriver } from "../../src/lib/drivers/brief-blob-http.ts";
import { createGroqDriverFromEnv, createGroqLimiter } from "../../src/lib/drivers/resolve-groq-driver.ts";
import { createReasoningLadders } from "../../src/lib/drivers/resolve-ladder.ts";
import { GROQ_REASONING_MODEL } from "../../src/config/models.ts";
import { buildPipelineEnv, requireEnv, type PipelineEnv } from "./env.ts";
import { renderOneVideo } from "./render.ts";

/**
 * The chat route's entry point (operator direction, 2026-09-04).
 *
 * **This file is a prelude, not a second pipeline.** It does three things the
 * brainstorm route does not need — read the brief, classify it, ground it —
 * and then it manufactures exactly the state `renderOneVideo` has always
 * expected (a `signals` row in `scored`, a run plan naming it) and calls it.
 * Everything from SCRIPT to EXPORT is the code that has been rendering videos
 * all week, unchanged and unaware.
 *
 * That is the whole design, and it is worth saying why. The obvious shape for
 * "a second way to make a video" is a second orchestrator, and it would have
 * meant two places that know about the Groq token bucket, the Gemini TTS
 * Pacific-day ledger, the sticky ladder descent, the audit contract and the
 * export lifecycle — with the second one quietly drifting from the first the
 * first time either changed. Instead the divergence is confined to one
 * nullable value (`OperatorBrief`) and one stage (RESEARCH), because RESEARCH
 * was already the only stage whose output crosses into the rest of the run.
 *
 * **There is one branch, and it is not about the operator.** Every brief
 * becomes a synthetic `signals` row minted from DIGEST's headline, and the
 * pipeline builds that. The vagueness branch — where a prompt DIGEST judged
 * thin was replaced by `rankIdeas`' top story for its topic — was deleted on
 * 2026-09-05 by operator direction, after a brief naming a specific trial
 * came back as an unrelated politics story because the model had returned no
 * angle for it. A prompt with nothing in it now simply gives grounded
 * RESEARCH a subject and no angle, which is a search it can still run.
 *
 * **What can fail, and what it costs.** DIGEST failing costs the run its
 * reading of the prompt and continues on the operator's own words, with the
 * topic guessed from them. Grounded research failing costs the brief its
 * grounding and hands the corpus path a real signal to work with. Both are
 * degrades that reach the audit package, and neither changes what is being
 * built.
 */

async function main(): Promise<void> {
  const briefId = requireEnv("PIPELINE_BRIEF_ID");
  const env = buildPipelineEnv();

  const brief = await getBrief(env.db, briefId);
  if (brief === null) {
    // Not a throw with a stack: the operator reads this in an Actions log.
    console.error(`No brief ${briefId} — nothing to render.`);
    process.exitCode = 1;
    return;
  }

  // The console decided the trace when it dispatched, exactly as it does for
  // the brainstorm route: GitHub's dispatch endpoint returns no run id, so the
  // identifier travels downward and the chat surface polls the trace this run
  // writes to. Minting one here would leave that surface watching a run that
  // never moves.
  const traceId = process.env.PIPELINE_TRACE_ID?.trim() || brief.traceId || crypto.randomUUID();

  // The dispatch row the console opened is still `succeeded` from the POST
  // being accepted; this is the invocation's own lifecycle row, open for
  // exactly as long as the invocation is (db/runs.ts's PIPELINE_STAGE).
  const lifecycleRunId = await startRun(env.db, PIPELINE_STAGE, traceId);

  try {
    const prepared = await runPrelude(env, brief.id, brief.prompt, traceId);

    await updateBrief(env.db, brief.id, { status: "running", planId: prepared.planId, signalId: prepared.signalId, digestJson: JSON.stringify(prepared.digest) });

    const outcome = await renderOneVideo(env, traceId, {
      planId: prepared.planId,
      brief: {
        id: brief.id,
        prompt: brief.prompt,
        research: prepared.research,
        researchProvenance: prepared.researchProvenance,
        voice: prepared.digest.voice,
        language: prepared.digest.language,
      },
    });
    await finishRun(env.db, lifecycleRunId, outcome.kind === "skipped" ? "skipped" : "succeeded", outcome.kind === "skipped" ? outcome.reason : undefined);
    await updateBrief(env.db, brief.id, outcome.kind === "skipped" ? { status: "failed", failureReason: outcome.reason } : { status: "succeeded" });
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 200);
    await finishRun(env.db, lifecycleRunId, "failed", message);
    // The brief carries the reason too, because the chat transcript is where
    // the operator is looking — not the run view, and certainly not the
    // Actions log.
    await updateBrief(env.db, brief.id, { status: "failed", failureReason: message });
    throw error;
  }
}

/**
 * The process-level half of the prelude: build the drivers, open and close the
 * stage row, and hand the rest to `prepareBrief`, which is where the prelude's
 * logic lives and where it is tested.
 */
async function runPrelude(env: PipelineEnv, briefId: string, prompt: string, traceId: string): Promise<PreparedBrief> {
  const llm = createGroqDriverFromEnv(env.groqApiKey, createGroqLimiter());
  const ladders = createReasoningLadders(llm, env.geminiApiKey);
  if (ladders.geminiUnavailableReason !== null) console.warn(`REASONING: ${ladders.geminiUnavailableReason}`);

  // Read before DIGEST because they are DIGEST's input, and never allowed to
  // stop it: an unreadable file is a line in the prompt saying so.
  const attachmentText = await readBriefAttachments(env, briefId);

  const digestRunId = await startRun(env.db, "digest", traceId);
  const prepared = await prepareBrief(briefId, prompt, {
    db: env.db,
    rawClient: env.rawClient,
    digestLlm: ladders.forStage("DIGEST"),
    attachmentText,
    model: GROQ_REASONING_MODEL,
    /**
     * Grounded RESEARCH, attempted here rather than inside `renderOneVideo`
     * because it is the one stage this route does differently — which keeps
     * the render function's brief-aware surface down to "was this already
     * researched?".
     *
     * A failure is reported and carried no further: the render then runs the
     * corpus path against the signal just minted, and if that fails too the
     * video is exported flagged `ungrounded`. Two fallbacks, neither of which
     * can cost the operator their video.
     */
    research: async (input) => {
      const grounded = await groundedResearch(env.geminiApiKey, input);
      if (grounded.ok) {
        // `brief.model` is whichever model actually closed it, and
        // `fallbackReason` says why that is not the first one — both go
        // straight into the audit package, because an export may never be
        // vague about which provider answered a reasoning stage.
        const { brief, fallbackReason } = grounded.value;
        return { brief, provenance: { provider: "gemini-grounded", model: brief.model, fallbackReason } };
      }
      console.warn(`RESEARCH: grounded research failed (${grounded.error.kind}: ${grounded.error.message}).`);
      return null;
    },
  });
  await finishRun(env.db, digestRunId, prepared.digestDegradedReason === null ? "succeeded" : "degraded", prepared.digestDegradedReason ?? undefined);
  return prepared;
}

/**
 * Reads the brief's attachments into text for DIGEST. Never throws, and never
 * blocks: a brief with no attachments, no blob store, or no readable file
 * returns an empty string and the classification proceeds on the prompt.
 */
async function readBriefAttachments(env: PipelineEnv, briefId: string): Promise<string> {
  const rows = await listBriefAttachments(env.db, briefId);
  if (rows.length === 0) return "";

  if (env.local) {
    // The local harness has no Worker and therefore no bucket to read from.
    // Said out loud rather than silently skipped: a local run that appears to
    // have digested an attachment it never saw is the kind of difference that
    // only shows up in production.
    console.warn(`BRIEF: ${rows.length} attachment(s) are in R2 and this is a local run — digesting from the prompt alone.`);
    return "";
  }

  const blobs = new BriefBlobDriver({ workerUrl: env.workerUrl, token: requireEnv("PIPELINE_BATCH_TOKEN") });

  const files: AttachmentBytes[] = [];
  for (const row of rows) {
    const bytes = await blobs.fetchAttachment(briefId, row.position);
    if (!bytes.ok) {
      console.warn(`BRIEF: attachment "${row.filename}" could not be fetched (${bytes.error.kind}: ${bytes.error.message}) — digesting without it.`);
      continue;
    }
    files.push({ filename: row.filename, mimeType: row.mimeType, bytes: bytes.value });
  }
  if (files.length === 0) return "";

  const reader = env.geminiApiKey === undefined ? null : createVisualReader(env.geminiApiKey);
  const read = await readAttachments(files, reader);
  for (const failure of read.unreadable) console.warn(`BRIEF: attachment "${failure.filename}" — ${failure.reason}`);
  return read.text;
}

// The sweeps `render.ts` runs at the top of every brainstorm invocation
// (stale runs, stranded picks, abandoned shots, expired exports, the source
// cache) are deliberately NOT repeated here. They are writes over shared
// rows, and two sweepers racing each other is worse than one that runs
// slightly less often — a brief-scoped invocation claims only from the plan
// it just queued, so nothing it touches is ambiguous either way.
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
