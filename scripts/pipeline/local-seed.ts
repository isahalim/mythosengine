#!/usr/bin/env node
/**
 * Seeds the local pipeline database (`PIPELINE_LOCAL=1`) with the two
 * things a RENDER needs that it cannot invent for itself: a footage
 * library it is allowed to draw from, and a directive to run under.
 *
 * Nothing here is fabricated. The footage rows are read from the actual
 * `.mp4.json` sidecars on the `assets-library` orphan branch, so the
 * segments registered are exactly the clips that exist — CLAUDE.md's
 * "never uses footage outside the maintained, provenance-tracked library"
 * holds locally too, and a clip that is not on that branch cannot be
 * seeded.
 *
 * Signals are NOT seeded. Those come from the real ingest
 * (`scripts/pipeline/watch.ts`, also runnable with PIPELINE_LOCAL=1),
 * because a hand-written signal would make the local run a demo of the
 * renderer rather than of the pipeline.
 */
import { execFileSync } from "node:child_process";
import { footageSegments, footageSources } from "../../db/schema.ts";
import { getOne } from "../../db/client.ts";
import { eq } from "drizzle-orm";
import { openLocalBackend } from "./local-backend.ts";
import { DEFAULT_DIRECTIVE } from "../../src/server/console/directive-schema.ts";
import { updateSettings } from "../../src/server/console/settings.ts";

const BRANCH = "assets-library";

interface ClipSidecar {
  footageSourceId: string;
  sourceVideoId: string;
  clipStartS: number;
  clipEndS: number;
  motionScore: number;
  fetchedAt: string;
}

function gitShow(path: string): string {
  return execFileSync("git", ["show", `${BRANCH}:${path}`], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

function listClipSidecars(): string[] {
  const out = execFileSync("git", ["ls-tree", "-r", "--name-only", BRANCH], { encoding: "utf8" });
  return out.split("\n").filter((p) => p.endsWith(".mp4.json"));
}

async function main(): Promise<void> {
  const { db, rawClient } = openLocalBackend();

  const sidecars = listClipSidecars();
  if (sidecars.length === 0) {
    throw new Error(`No clips found on the ${BRANCH} branch — there is no footage to render with. Run FOOTAGE REFRESH, or fetch the branch.`);
  }

  let sources = 0;
  let segments = 0;

  for (const sidecarPath of sidecars) {
    const meta = JSON.parse(gitShow(sidecarPath)) as ClipSidecar;
    const libraryPath = sidecarPath.replace(/\.json$/, "");
    // The game is the second half of the source id by the library's own
    // naming convention (`<channel>-<game>`), which is how the clips on the
    // branch are actually named.
    const game = meta.footageSourceId.split("-").slice(1).join("-") || meta.footageSourceId;

    const existingSource = await getOne(db.select().from(footageSources).where(eq(footageSources.id, meta.footageSourceId)));
    if (!existingSource) {
      await db
        .insert(footageSources)
        .values({
          id: meta.footageSourceId,
          channelUrl: "https://www.youtube.com/@HollowPoiint",
          game,
          licenseNote: "Maintained library clip, provenance recorded on the assets-library branch.",
          enabled: 1,
        })
        .run();
      sources++;
    }

    const segmentId = `${meta.sourceVideoId}-${meta.clipStartS}`;
    const existingSegment = await getOne(db.select().from(footageSegments).where(eq(footageSegments.id, segmentId)));
    if (!existingSegment) {
      await db
        .insert(footageSegments)
        .values({
          id: segmentId,
          footageSourceId: meta.footageSourceId,
          sourceVideoId: meta.sourceVideoId,
          clipStartS: meta.clipStartS,
          clipEndS: meta.clipEndS,
          motionScore: meta.motionScore,
          libraryPath,
          fetchedAt: meta.fetchedAt,
        })
        .run();
      segments++;
    }
  }

  const settings = await updateSettings(db, rawClient, DEFAULT_DIRECTIVE, "local end-to-end run");

  console.warn(`local-seed: ${sources} footage source(s), ${segments} segment(s) registered from ${BRANCH}.`);
  console.warn(`local-seed: directive v${settings.version} active (defaults).`);
}

main().catch((cause: unknown) => {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exit(1);
});
