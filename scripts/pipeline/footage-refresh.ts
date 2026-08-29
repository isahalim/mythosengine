#!/usr/bin/env node
import { finishRun, startRun } from "../../db/runs.ts";
import { footageSources } from "../../db/schema.ts";
import { isPipelineEnabled } from "../../src/server/console/killswitch.ts";
import { refreshFootageSource } from "../../src/lib/footage/refresh.ts";
import { AgenticYoutubeSearchDriver } from "../../src/lib/drivers/youtube-search-agentic.ts";
import { AgenticYtmp3DownloadDriver } from "../../src/lib/drivers/download-agentic-ytmp3.ts";
import { createGroqDriverFromEnv } from "../../src/lib/drivers/resolve-groq-driver.ts";
import { TokenBucketLimiter } from "../../src/lib/drivers/rate-limiter.ts";
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
  const llm = createGroqDriverFromEnv(env.groqApiKey, new TokenBucketLimiter(30, 6000));

  const traceId = crypto.randomUUID();
  const drivers = {
    search: new AgenticYoutubeSearchDriver({ llm }),
    download: new AgenticYtmp3DownloadDriver({ llm }),
  };

  const sources = await env.db.select().from(footageSources).all();
  let anyFailed = false;

  for (const source of sources) {
    const runId = await startRun(env.db, "footage_refresh", traceId);
    try {
      const result = await refreshFootageSource(env.db, source, drivers);
      await finishRun(env.db, runId, result.status === "failed" ? "failed" : "succeeded", result.error?.message);
      const detail = result.error ? ` (${result.error.kind}: ${result.error.message})` : "";
      console.warn(`FOOTAGE REFRESH [${source.id}]: ${result.status}, ${result.newSegments} new segments.${detail}`);
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
