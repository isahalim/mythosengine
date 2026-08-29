#!/usr/bin/env node
import { finishRun, startRun } from "../../db/runs.ts";
import { footageSources } from "../../db/schema.ts";
import { isPipelineEnabled } from "../../src/server/console/killswitch.ts";
import { refreshFootageSource } from "../../src/lib/footage/refresh.ts";
import { YoutubeDataApiSearchDriver } from "../../src/lib/drivers/youtube-search.ts";
import { YtDlpDownloadDriver } from "../../src/lib/drivers/download-ytdlp.ts";
import { buildPipelineEnv, requireEnv } from "./env.ts";

/**
 * FOOTAGE REFRESH (ARCHITECTURE.md §5.0), weekly cron
 * (.github/workflows/footage-refresh.yml) — the only stage that touches
 * third-party video. `refreshFootageSource` commits new clips to the
 * `assets-library` orphan branch locally only (src/lib/footage/library.ts's
 * `commitClipToLibrary` deliberately doesn't push); the workflow itself
 * runs `git push origin assets-library` once every source has been
 * processed.
 */
async function main(): Promise<void> {
  const env = buildPipelineEnv();
  const youtubeApiKey = requireEnv("YOUTUBE_API_KEY");

  if (!(await isPipelineEnabled(env.hotKv))) {
    console.warn("Pipeline killswitch is off — skipping this FOOTAGE REFRESH run.");
    return;
  }

  const traceId = crypto.randomUUID();
  const drivers = {
    search: new YoutubeDataApiSearchDriver({ apiKey: youtubeApiKey }),
    download: new YtDlpDownloadDriver(),
  };

  const sources = await env.db.select().from(footageSources).all();
  let anyFailed = false;

  for (const source of sources) {
    const runId = await startRun(env.db, "footage_refresh", traceId);
    try {
      const result = await refreshFootageSource(env.db, source, drivers);
      await finishRun(env.db, runId, result.status === "failed" ? "failed" : "succeeded");
      console.warn(`FOOTAGE REFRESH [${source.id}]: ${result.status}, ${result.newSegments} new segments.`);
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
