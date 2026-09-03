import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../../../db/client.ts";
import { applyMigrations } from "../../../db/apply-migrations.ts";
import { footageSegments, footageSources } from "../../../db/schema.ts";
import { saveShotPlan, shotsForScripts } from "../../../db/shot-plans.ts";
import { scripts, signals, sources } from "../../../db/schema.ts";
import { claimNextFootageSegment } from "../../../db/footage-select.ts";
import { PexelsDriver } from "../drivers/pexels.ts";
import type { DownloadDriver, YoutubeSearchDriver } from "../drivers/types.ts";
import { ok } from "../result.ts";
import type { ShotPlan } from "../pipeline/shot-plan.ts";
import { sourceShots, youtubeDownloadBudget } from "./source-agent.ts";

// The ffmpeg-shaped work (probe, trim, motion-score, cut) is exercised by
// its own modules' tests against real ffmpeg. What is under test HERE is
// selection, provenance and the plan rows — so those are stubbed, and the
// stubs are honest about it rather than pretending to encode anything.
vi.mock("../drivers/probe-video.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../drivers/probe-video.ts")>();
  return { ...original, probeVideo: async () => ({ ok: true as const, value: { durationS: 3600 } }) };
});
vi.mock("./clip.ts", () => ({
  trimHeadTail: async (_s: string, _d: number, headTailS: number, outputPath: string) => ({
    ok: true as const,
    value: { filePath: outputPath, keptFromS: headTailS, keptDurationS: 3600 - 2 * headTailS },
  }),
  extractClip: async (_s: string, _start: number, _dur: number, outputPath: string) => ({ ok: true as const, value: { filePath: outputPath } }),
}));
vi.mock("./motion-score.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./motion-score.ts")>();
  return {
    ...original,
    computeMotionSeries: async () => ({ ok: true as const, value: Array.from({ length: 600 }, (_, i) => ({ ptsTimeS: i, motion: i % 37 })) }),
  };
});

const NOW = "2026-09-01T12:00:00.000Z";

function pexelsFetch(): typeof fetch {
  let next = 5000;
  return (async (url: string) => {
    if (url.startsWith("https://api.pexels.com/")) {
      const id = ++next;
      return new Response(
        JSON.stringify({
          videos: [
            {
              id,
              url: `https://www.pexels.com/video/clip-${id}/`,
              image: `https://images.pexels.com/videos/${id}/t.jpg`,
              duration: 12,
              user: { name: "A Photographer" },
              video_files: [{ link: `https://player.pexels.com/${id}-1080.mp4`, file_type: "video/mp4", width: 1080, height: 1920 }],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "content-type": "video/mp4" } });
  }) as unknown as typeof fetch;
}

/** One distinct video per distinct query, so the cache and the cap are separable in a test. */
function searchDriver(queriesSeen: string[]): YoutubeSearchDriver {
  const idByQuery = new Map<string, string>();
  return {
    findTopLongFormVideos: async (req) => {
      const query = req.query ?? `${req.channelHandle}`;
      queriesSeen.push(query);
      const id = idByQuery.get(query) ?? `vid${idByQuery.size}abcdefg`;
      idByQuery.set(query, id);
      return ok([{ videoId: id, title: `${query} — full walkthrough`, durationS: 3600, viewCount: 900_000 }]);
    },
  };
}

function downloadDriver(downloads: string[]): DownloadDriver {
  return {
    fetchVideo: async (req) => {
      downloads.push(req.url);
      const path = join(tmpdir(), `dl-${downloads.length}-${Date.now()}.mp4`);
      await import("node:fs/promises").then((fs) => fs.writeFile(path, Buffer.alloc(64)));
      return ok({ filePath: path, durationS: 3600, sourceVideoId: "sourced" });
    },
  };
}

function plan(shots: ShotPlan["shots"], origin: ShotPlan["origin"] = "model"): ShotPlan {
  return { shots, origin, degradedReason: null };
}

describe("sourceShots", () => {
  let ctx: ReturnType<typeof createTestDb>;
  let workDir: string;
  let repoDir: string;

  beforeEach(async () => {
    ctx = createTestDb();
    applyMigrations(ctx.client);
    workDir = await mkdtemp(join(tmpdir(), "source-work-"));
    repoDir = await mkdtemp(join(tmpdir(), "source-repo-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
  });

  function deps(extra: Partial<Parameters<typeof sourceShots>[1]> = {}) {
    return {
      db: ctx.db,
      pexels: new PexelsDriver("k", { fetchImpl: pexelsFetch() }),
      search: searchDriver([]),
      download: downloadDriver([]),
      workDir,
      repoDir,
      nowIso: NOW,
      ...extra,
    };
  }

  it("sources a mixed plan from both providers, in plan order", async () => {
    const result = await sourceShots(
      plan([
        { position: 0, beatIndex: null, intent: "opening", query: "empty courtroom gallery", source: "pexels" },
        { position: 1, beatIndex: 0, intent: "the real thing", query: "GTA 6 walkthrough gameplay", source: "youtube" },
        { position: 2, beatIndex: 1, intent: "closing", query: "hands sorting paperwork", source: "pexels" },
      ]),
      deps(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.shots.map((s) => s.source)).toEqual(["pexels", "youtube", "pexels"]);
    expect(result.value.shots.map((s) => s.position)).toEqual([0, 1, 2]);
  });

  it("writes provenance for every clip before it could reach an encoder", async () => {
    // Footage is ephemeral now: no bytes survive the run, so these rows are
    // the only record that a frame came from anywhere.
    await sourceShots(
      plan([
        { position: 0, beatIndex: null, intent: "a", query: "empty courtroom gallery", source: "pexels" },
        { position: 1, beatIndex: 0, intent: "b", query: "GTA 6 walkthrough gameplay", source: "youtube" },
      ]),
      deps(),
    );

    const rows = await ctx.db.select().from(footageSegments).all();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.provider === "pexels" || row.provider === "youtube").toBe(true);
      expect(row.searchQuery).not.toBeNull();
      expect(row.pageUrl).not.toBeNull();
      // The locator is a provider URL, never a path: nothing is stored.
      expect(row.libraryPath.startsWith("http")).toBe(true);
    }
  });

  it("downloads a repeated YouTube query once and cuts several windows from it", async () => {
    // Every viral plan is this shape by construction. Downloading per shot
    // would pull the same gigabyte four times.
    const downloads: string[] = [];
    const result = await sourceShots(
      plan(
        Array.from({ length: 4 }, (_, i) => ({
          position: i,
          beatIndex: i === 0 ? null : i - 1,
          intent: "gameplay",
          query: "GTA 6 walkthrough gameplay",
          source: "youtube" as const,
        })),
        "viral_gameplay",
      ),
      deps({ download: downloadDriver(downloads), random: () => 0.5 }),
    );

    expect(downloads).toHaveLength(1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.shots).toHaveLength(4);
    // Four different moments of the same source, not the same one four times.
    expect(new Set(result.value.shots.map((s) => s.segmentId)).size).toBe(4);
  });

  it("reports offsets against the original video, not the trimmed body", async () => {
    // A reviewer checking provenance opens the source; the head/tail buffer
    // is our bookkeeping, not theirs.
    await sourceShots(
      plan([{ position: 0, beatIndex: null, intent: "g", query: "GTA 6 walkthrough gameplay", source: "youtube" }], "viral_gameplay"),
      deps({ random: () => 0 }),
    );

    const row = (await ctx.db.select().from(footageSegments).all())[0];
    expect(row.clipStartS).toBeGreaterThanOrEqual(120);
  });

  it("caps YouTube downloads per render and falls the rest back to stock", async () => {
    const downloads: string[] = [];
    const search = searchDriver([]);
    const result = await sourceShots(
      plan([
        { position: 0, beatIndex: null, intent: "a", query: "first youtube thing", source: "youtube" },
        { position: 1, beatIndex: 0, intent: "b", query: "second youtube thing", source: "youtube" },
        { position: 2, beatIndex: 1, intent: "c", query: "third youtube thing", source: "youtube" },
      ]),
      deps({ download: downloadDriver(downloads), search }),
    );

    expect(downloads).toHaveLength(2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The third beat still gets a picture, from stock, and the reason is
    // reported rather than the shot silently vanishing.
    expect(result.value.shots).toHaveLength(3);
    expect(result.value.shots[2].source).toBe("pexels");
    expect(result.value.failures.some((f) => f.error.includes("download budget"))).toBe(true);
  });

  it("raises the download budget to 4 on the topics whose footage is the real thing", async () => {
    // politics/tech/science/ai: the actual recorded event exists and stock
    // has no clip of it, so two real clips across a montage is mostly stock
    // (operator direction, 2026-09-01).
    const downloads: string[] = [];
    const search = searchDriver([]);
    const result = await sourceShots(
      plan(
        Array.from({ length: 5 }, (_, i) => ({
          position: i,
          beatIndex: i === 0 ? null : i - 1,
          intent: "a",
          query: `youtube thing ${i}`,
          source: "youtube" as const,
        })),
      ),
      deps({ download: downloadDriver(downloads), search, topic: "politics" }),
    );

    expect(downloads).toHaveLength(4);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The fifth still falls back to stock — it is a raised cap, not no cap.
    expect(result.value.shots[4].source).toBe("pexels");
  });

  it("keeps the conservative budget on a topic nobody chose", () => {
    expect(youtubeDownloadBudget(null)).toBe(2);
    expect(youtubeDownloadBudget("philosophy")).toBe(2);
    expect(youtubeDownloadBudget("politics")).toBe(4);
    expect(youtubeDownloadBudget("ai")).toBe(4);
  });

  it("does not spend a download slot on a source it already has cached", async () => {
    // A cache hit costs no bandwidth and no converter round trip, so
    // counting one against the ceiling would refuse footage already on
    // disk. Three shots, one video, one download, all three sourced.
    const downloads: string[] = [];
    const search = searchDriver([]);
    const shared = deps({ download: downloadDriver(downloads), search });

    const result = await sourceShots(
      plan([
        { position: 0, beatIndex: null, intent: "a", query: "one query", source: "youtube" },
        { position: 1, beatIndex: 0, intent: "b", query: "one query", source: "youtube" },
        { position: 2, beatIndex: 1, intent: "c", query: "one query", source: "youtube" },
      ]),
      shared,
    );

    expect(downloads).toHaveLength(1);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.shots).toHaveLength(3);
  });

  it("never lets sourced footage satisfy a gameplay claim", async () => {
    await sourceShots(plan([{ position: 0, beatIndex: null, intent: "g", query: "GTA 6 walkthrough gameplay", source: "youtube" }]), deps());
    const source = (await ctx.db.select().from(footageSources).all())[0];
    expect(source.kind).toBe("stock");
    expect(await claimNextFootageSegment(ctx.db, source.game, NOW)).toBeNull();
  });

  it("fails rather than composing a video with no footage at all", async () => {
    const emptyPexels = new PexelsDriver("k", {
      fetchImpl: (async () => new Response(JSON.stringify({ videos: [] }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
    });
    const result = await sourceShots(
      plan([{ position: 0, beatIndex: null, intent: "a", query: "empty courtroom gallery", source: "pexels" }]),
      deps({ pexels: emptyPexels }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("no shot in the plan could be sourced");
  });

  it("advances each shot's plan row as it is really searched and cut", async () => {
    await ctx.db.insert(sources).values({ id: "s1", kind: "reddit", url: "http://x" }).run();
    await ctx.db.insert(signals).values({ id: "sig1", sourceId: "s1", canonicalUrl: "http://x/1", title: "t", observedAt: NOW, engagementScore: 1, simhash: "a", state: "scored" }).run();
    await ctx.db.insert(scripts).values({ id: "scr1", signalId: "sig1", hook: "h", body: "b", debateQuestion: "q", wordCount: 5, status: "draft", createdAt: NOW }).run();
    await saveShotPlan(ctx.client, "scr1", "trace1", [{ position: 0, beatIndex: null, intent: "a", query: "empty courtroom gallery", source: "pexels" }], NOW);

    await sourceShots(
      plan([{ position: 0, beatIndex: null, intent: "a", query: "empty courtroom gallery", source: "pexels" }]),
      deps({ scriptId: "scr1" }),
    );

    const rows = await shotsForScripts(ctx.db, ["scr1"]);
    expect(rows[0].status).toBe("clipped");
    expect(rows[0].footageSegmentId).not.toBeNull();
  });
});

describe("plan position vs composited position", () => {
  let ctx: ReturnType<typeof createTestDb>;
  let workDir: string;
  let repoDir: string;

  beforeEach(async () => {
    ctx = createTestDb();
    applyMigrations(ctx.client);
    workDir = await mkdtemp(join(tmpdir(), "source-work-"));
    repoDir = await mkdtemp(join(tmpdir(), "source-repo-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
  });

  it("keeps the original plan position when a middle shot fails to source", async () => {
    // Plan shots 0,1,2 where 1 finds nothing. The survivors composite at
    // 0 and 1, but their plan rows are still 0 and 2 — and advancing a row
    // by the composited number would mark the FAILED shot as composited and
    // leave the real one stuck, i.e. stage 5 showing the wrong shot as
    // being in the video.
    let call = 0;
    const pexels = new PexelsDriver("k", {
      fetchImpl: (async (url: string) => {
        if (url.startsWith("https://api.pexels.com/")) {
          call += 1;
          if (call === 2) return new Response(JSON.stringify({ videos: [] }), { status: 200, headers: { "content-type": "application/json" } });
          const id = 7000 + call;
          return new Response(
            JSON.stringify({
              videos: [
                {
                  id,
                  url: `https://www.pexels.com/video/clip-${id}/`,
                  image: `https://images.pexels.com/videos/${id}/t.jpg`,
                  duration: 12,
                  user: { name: "P" },
                  video_files: [{ link: `https://player.pexels.com/${id}-1080.mp4`, file_type: "video/mp4", width: 1080, height: 1920 }],
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "content-type": "video/mp4" } });
      }) as unknown as typeof fetch,
    });

    const result = await sourceShots(
      {
        shots: [
          { position: 0, beatIndex: null, intent: "a", query: "empty courtroom gallery", source: "pexels" },
          { position: 1, beatIndex: 0, intent: "b", query: "prison corridor night", source: "pexels" },
          { position: 2, beatIndex: 1, intent: "c", query: "hands sorting paperwork", source: "pexels" },
        ],
        origin: "model",
        degradedReason: null,
      },
      {
        db: ctx.db,
        pexels,
        search: searchDriver([]),
        download: downloadDriver([]),
        workDir,
        repoDir,
        nowIso: NOW,
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.shots).toHaveLength(2);
    expect(result.value.shots.map((s) => s.position)).toEqual([0, 1]);
    expect(result.value.shots.map((s) => s.planPosition)).toEqual([0, 2]);
  });
});
