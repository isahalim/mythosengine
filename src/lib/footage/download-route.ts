import { DomYtmp3DownloadDriver } from "../drivers/download-ytmp3-dom.ts";
import { YtDlpDownloadDriver } from "../drivers/download-ytdlp.ts";
import type { DownloadDriver } from "../drivers/types.ts";

/**
 * How this system gets a YouTube video onto disk.
 *
 * One home for the choice, because there are now two callers — the weekly
 * FOOTAGE REFRESH and the per-render sourcing agent
 * (src/lib/footage/source-agent.ts) — and a second copy of the copyright
 * attestation decision below is exactly the kind of thing that drifts.
 */
function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim().length === 0 ? undefined : value.trim();
}

/**
 * Picks the acquisition route. Two exist, both satisfy `DownloadDriver`, and
 * the choice is made here rather than inside either one.
 *
 * `ytdlp` is the default (operator directive, 2026-08-30). The converter
 * route was the only one until `media.ytmp3.gg` began answering
 * GitHub-hosted runners with a "Service Discontinued" modal while serving a
 * working page to residential addresses — a failure no amount of correct
 * driver code can route around, because it is about *where the job runs*.
 * `ytmp3` is kept, not deleted: it was verified working end to end from a
 * residential IP on 2026-08-30, and a second route that works from a
 * different place is exactly what makes the next such block survivable.
 *
 * Both routes are deterministic and spend no model tokens, so this switch
 * costs nothing either way.
 */
export function buildDownloadDriver(label: string): DownloadDriver {
  const choice = optionalEnv("FOOTAGE_DOWNLOADER") ?? "ytdlp";

  if (choice === "ytmp3") {
    console.warn(`${label}: acquiring via the ytmp3.gg converter (FOOTAGE_DOWNLOADER=ytmp3).`);
    return new DomYtmp3DownloadDriver({
      // ytmp3.gg gates its Convert button behind a checkbox asserting the
      // user will not download copyrighted content. Enabled by explicit
      // operator decision (2026-08-29): the same accepted risk profile
      // already recorded in docs/DECISIONS.md and in every
      // footage_sources.license_note row, which describe this material as
      // copyrighted walkthrough footage used under heavy transformation --
      // "not a claim of zero risk." The driver defaults this to false
      // precisely so the choice has to be made here, deliberately, rather
      // than assumed by a library.
      acceptCopyrightAttestation: true,
      // 1080p, stated at the call site rather than left to the driver's
      // default, because affording it is a property of *which channel we
      // pull from* and not of the driver. At ~27 MB per source-minute
      // (measured 2026-08-29), @HollowPoiint's ~1h episodes land near
      // 1.6 GB — comfortably inside the driver's 6 GB ceiling.
      videoQuality: "mp4-1080",
    });
  }

  if (choice !== "ytdlp") {
    // Not defaulted past: a typo here would silently acquire footage by a
    // route the operator did not choose, and footage sourcing is the one
    // area CLAUDE.md says never to guess in.
    throw new Error(`FOOTAGE_DOWNLOADER="${choice}" is not a known acquisition route (expected "ytdlp" or "ytmp3").`);
  }

  console.warn(`${label}: acquiring via yt-dlp.`);
  // The binary is pinned and checksummed by the workflow rather than
  // installed from npm (ARCHITECTURE.md's ffmpeg reasoning, applied to the
  // other non-npm binary this pipeline shells out to); the path is passed
  // in so the workflow decides where that pinned copy lives.
  return new YtDlpDownloadDriver({ ytDlpBin: optionalEnv("YT_DLP_BIN") });
}
