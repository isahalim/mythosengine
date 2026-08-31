#!/usr/bin/env node
import { eq } from "drizzle-orm";
import { finishRun, reapStaleRuns, startRun } from "../../db/runs.ts";
import { footageSources } from "../../db/schema.ts";
import { isPipelineEnabled } from "../../src/server/console/killswitch.ts";
import { refreshFootageSource } from "../../src/lib/footage/refresh.ts";
import { DomYoutubeSearchDriver } from "../../src/lib/drivers/youtube-search-dom.ts";
import { DomYtmp3DownloadDriver } from "../../src/lib/drivers/download-ytmp3-dom.ts";
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
 * Acquisition drives a real headless browser (ARCHITECTURE.md §5.0) instead
 * of the YouTube Data API + yt-dlp this replaced, and as of 2026-08-29 both
 * legs are deterministic: **this job makes no model calls at all.** See the
 * two driver files for the guardrails (origin allowlisting, ffprobe
 * validation of anything downloaded, a byte ceiling on the download).
 *
 * `buildPipelineEnv()` still requires GROQ_API_KEY — it is shared with the
 * daily render pipeline, which does call Groq. Nothing in this job reads it.
 */
async function main(): Promise<void> {
  const env = buildPipelineEnv();

  if (!(await isPipelineEnabled(env.hotKv))) {
    console.warn("Pipeline killswitch is off — skipping this FOOTAGE REFRESH run.");
    return;
  }

  // A previous run killed by the Actions job timeout leaves its row
  // `running` forever, which the console then reports as a live stage.
  // Swept here rather than in the console: this is a write, and the
  // pipeline owns the runs table.
  const reaped = await reapStaleRuns(env.db);
  if (reaped > 0) console.warn(`Reaped ${reaped} abandoned run row(s) left behind by a killed job.`);

  const traceId = crypto.randomUUID();
  // Both legs are plain code. Reading a results page has one right answer,
  // and so does driving ytmp3.gg's form: it is a fixed, id-addressed state
  // machine, and "wait for the conversion" is a poll on the page's own
  // ready/error state, not a judgement call. The agentic download driver
  // that used to sit here was removed on 2026-08-29 (operator directive)
  // once that was demonstrated end to end against the live site.
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
    download: new DomYtmp3DownloadDriver({
      acceptCopyrightAttestation: true,
      // 1080p, stated at the call site rather than left to the driver's
      // default, because affording it is a property of *which channel we
      // pull from* and not of the driver. At ~27 MB per source-minute
      // (measured 2026-08-29), @HollowPoiint's ~1h episodes land near
      // 1.6 GB — comfortably inside the driver's 6 GB ceiling. The 4h+
      // candidates from the channels retired in migration 0008 did not
      // fit, which is the whole reason this is the only source left.
      videoQuality: "mp4-1080",
    }),
  };

  // Disabled sources (db/migrations/0008) are skipped, not deleted: their
  // existing segments stay in the library with their provenance intact.
  const sources = await env.db.select().from(footageSources).where(eq(footageSources.enabled, 1)).all();
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
