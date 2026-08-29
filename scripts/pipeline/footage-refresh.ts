#!/usr/bin/env node
import { finishRun, startRun } from "../../db/runs.ts";
import { footageSources } from "../../db/schema.ts";
import { isPipelineEnabled } from "../../src/server/console/killswitch.ts";
import { refreshFootageSource } from "../../src/lib/footage/refresh.ts";
import { DomYoutubeSearchDriver } from "../../src/lib/drivers/youtube-search-dom.ts";
import { AgenticYtmp3DownloadDriver } from "../../src/lib/drivers/download-agentic-ytmp3.ts";
import { createGroqDriverFromEnv, createGroqLimiter } from "../../src/lib/drivers/resolve-groq-driver.ts";
import { buildPipelineEnv } from "./env.ts";

/**
 * FOOTAGE REFRESH (ARCHITECTURE.md §5.0), weekly cron
 * (.github/workflows/footage-refresh.yml) — the only stage that touches
 * third-party video. `refreshFootageSource` commits new clips to the
 * `assets-library` orphan branch locally only (src/lib/footage/library.ts's
 * `commitClipToLibrary` deliberately doesn't push); the workflow itself
 * runs `git push origin assets-library` once every source has been
 * processed.
 *
 * Acquisition is agentic (ARCHITECTURE.md §5.0, operator directive): search
 * and download both drive a real headless browser via a bounded Groq
 * tool-calling loop (src/lib/drivers/browser-agent-core.ts) instead of the
 * YouTube Data API + yt-dlp this replaced — see that module and the two
 * driver files for the guardrails (origin allowlisting, ffprobe validation
 * of anything downloaded).
 */
async function main(): Promise<void> {
  const env = buildPipelineEnv();

  if (!(await isPipelineEnabled(env.hotKv))) {
    console.warn("Pipeline killswitch is off — skipping this FOOTAGE REFRESH run.");
    return;
  }

  // A separate limiter instance from the daily SCRIPT/CRITIC pipeline's
  // (render.ts) — this job runs weekly and alone, never concurrently with a
  // render, so there's no cross-job budget to share.
  const llm = createGroqDriverFromEnv(env.groqApiKey, createGroqLimiter());

  const traceId = crypto.randomUUID();
  // Split on purpose: search is deterministic, download is agentic.
  // Reading a results page has one right answer and no ambiguity to
  // resolve, so it costs zero tokens now (youtube-search-dom.ts). Driving
  // ytmp3.gg genuinely varies — the layout shifts, ad interstitials appear,
  // the convert step has to be waited out — so that leg keeps the model.
  const drivers = {
    search: new DomYoutubeSearchDriver(),
    // ytmp3.gg gates its Convert button behind a checkbox asserting the user
    // will not download copyrighted content. Enabled by explicit operator
    // decision (2026-08-29): the same accepted risk profile already recorded
    // in docs/DECISIONS.md and in every footage_sources.license_note row,
    // which describe this material as copyrighted walkthrough footage used
    // under heavy transformation -- "not a claim of zero risk." The driver
    // defaults this to false precisely so the choice has to be made here,
    // deliberately, rather than assumed by a library.
    download: new AgenticYtmp3DownloadDriver({ llm, acceptCopyrightAttestation: true }),
  };

  const sources = await env.db.select().from(footageSources).all();
  let anyFailed = false;

  console.warn(`FOOTAGE REFRESH: ${sources.length} source(s) to process.`);

  for (const source of sources) {
    const runId = await startRun(env.db, "footage_refresh", traceId);
    const startedAt = Date.now();
    // Announced before the work, not only after it: a source that hangs used
    // to produce no output at all, so the run log could not even say which
    // source it died on (2026-08-29).
    console.warn(`FOOTAGE REFRESH [${source.id}]: starting (${source.game}, ${source.channelUrl}).`);
    try {
      const result = await refreshFootageSource(env.db, source, drivers);
      await finishRun(env.db, runId, result.status === "failed" ? "failed" : "succeeded", result.error?.message);
      const detail = result.error ? ` (${result.error.kind}: ${result.error.message})` : "";
      console.warn(`FOOTAGE REFRESH [${source.id}]: ${result.status}, ${result.newSegments} new segments in ${Math.round((Date.now() - startedAt) / 1000)}s.${detail}`);
      if (result.status === "failed") anyFailed = true;
    } catch (cause) {
      await finishRun(env.db, runId, "failed", cause instanceof Error ? cause.message : String(cause));
      anyFailed = true;
      console.error(`FOOTAGE REFRESH [${source.id}] threw:`, cause);
    }
  }

  if (anyFailed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
