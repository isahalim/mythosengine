import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../../../db/client.ts";
import { applyMigrations } from "../../../db/apply-migrations.ts";
import { runs, scripts, signals, sources } from "../../../db/schema.ts";
import { Vault } from "../../lib/vault.ts";
import { getRunMontage } from "./montage.ts";

class FakeKv {
  readonly store = new Map<string, string>();
  readonly ttls = new Map<string, number | undefined>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, value);
    this.ttls.set(key, options?.expirationTtl);
  }
}

const MASTER_KEY_B64 = "3q2-7_zdaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TRACE = "trace-1";
const PEXELS_KEY = "a".repeat(56);

function pexelsResponse(id: number): Response {
  return new Response(
    JSON.stringify({
      videos: [
        {
          id,
          url: `https://www.pexels.com/video/clip-${id}/`,
          image: `https://images.pexels.com/videos/${id}/thumb.jpg`,
          duration: 10,
          user: { name: "A Photographer" },
          video_files: [{ link: `https://player.pexels.com/${id}-720.mp4`, file_type: "video/mp4", width: 720, height: 1280 }],
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("getRunMontage", () => {
  let ctx: ReturnType<typeof createTestDb>;
  let hotKv: FakeKv;
  let vaultKv: FakeKv;

  async function seedRunWithScript(): Promise<void> {
    await ctx.db.insert(sources).values({ id: "src1", kind: "reddit", url: "http://x" }).run();
    await ctx.db
      .insert(signals)
      .values({ id: "sig1", sourceId: "src1", canonicalUrl: "http://x/1", title: "t", observedAt: "2026-08-31T00:00:00.000Z", engagementScore: 1, simhash: "a", state: "scripted" })
      .run();
    await ctx.db.insert(runs).values({ id: "r1", startedAt: "2026-08-31T10:00:00.000Z", stage: "script", status: "running", traceId: TRACE }).run();
    await ctx.db
      .insert(scripts)
      .values({
        id: "scr1",
        signalId: "sig1",
        hook: "Your city is watching you sleep.",
        body: "Councils bought the cameras quietly, and the city never voted on it.",
        debateQuestion: "Would you have voted for it?",
        wordCount: 140,
        status: "draft",
        traceId: TRACE,
        createdAt: "2026-08-31T10:00:30.000Z",
      })
      .run();
  }

  beforeEach(() => {
    ctx = createTestDb();
    applyMigrations(ctx.client);
    hotKv = new FakeKv();
    vaultKv = new FakeKv();
  });

  it("returns null for a trace with no run rows", async () => {
    expect(await getRunMontage(ctx.db, hotKv, vaultKv, MASTER_KEY_B64, undefined, "nope")).toBeNull();
  });

  it("reports configured: false rather than an empty montage when no Pexels key exists anywhere", async () => {
    await seedRunWithScript();

    const montage = await getRunMontage(ctx.db, hotKv, vaultKv, MASTER_KEY_B64, undefined, TRACE);

    expect(montage).toEqual({ traceId: TRACE, configured: false, videos: [], failures: [] });
  });

  it("searches the script's keywords and returns clips tagged with the keyword that found them", async () => {
    await seedRunWithScript();
    const fetchImpl = vi.fn(async () => pexelsResponse(1));
    vi.stubGlobal("fetch", fetchImpl);

    const montage = await getRunMontage(ctx.db, hotKv, vaultKv, MASTER_KEY_B64, PEXELS_KEY, TRACE);

    expect(montage?.configured).toBe(true);
    expect(montage?.videos).toHaveLength(1);
    const video = montage?.videos[0];
    expect(video?.keywords.length).toBeGreaterThan(0);
    expect(video?.clips.length).toBeGreaterThan(0);
    expect(video?.clips[0].keyword).toBe(video?.keywords[0]);
    expect(video?.clips[0].photographer).toBe("A Photographer");
    vi.unstubAllGlobals();
  });

  it("caches a keyword's clips in KV with a TTL, and does not search it twice", async () => {
    await seedRunWithScript();
    const fetchImpl = vi.fn(async () => pexelsResponse(1));
    vi.stubGlobal("fetch", fetchImpl);

    await getRunMontage(ctx.db, hotKv, vaultKv, MASTER_KEY_B64, PEXELS_KEY, TRACE);
    const callsAfterFirst = fetchImpl.mock.calls.length;
    await getRunMontage(ctx.db, hotKv, vaultKv, MASTER_KEY_B64, PEXELS_KEY, TRACE);

    expect(fetchImpl.mock.calls.length).toBe(callsAfterFirst);
    expect([...hotKv.store.keys()].every((key) => key.startsWith("montage:pexels:v1:"))).toBe(true);
    expect([...hotKv.ttls.values()].every((ttl) => ttl === 24 * 60 * 60)).toBe(true);
    vi.unstubAllGlobals();
  });

  it("prefers a key rotated into the vault over the env fallback", async () => {
    await seedRunWithScript();
    const vault = new Vault(vaultKv, MASTER_KEY_B64);
    await vault.rotate("PEXELS_API_KEY", "vault-key-value");
    const seenAuth: (string | undefined)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        seenAuth.push((init?.headers as Record<string, string> | undefined)?.authorization);
        return pexelsResponse(1);
      }),
    );

    await getRunMontage(ctx.db, hotKv, vaultKv, MASTER_KEY_B64, PEXELS_KEY, TRACE);

    expect(seenAuth[0]).toBe("vault-key-value");
    vi.unstubAllGlobals();
  });

  it("surfaces a failed search as a named failure instead of swallowing it", async () => {
    await seedRunWithScript();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));

    const montage = await getRunMontage(ctx.db, hotKv, vaultKv, MASTER_KEY_B64, PEXELS_KEY, TRACE);

    expect(montage?.failures.length).toBeGreaterThan(0);
    expect(montage?.failures[0].error).toMatch(/provider_error|rate_limited|network|invalid_response/);
    expect(montage?.videos[0].clips).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("has nothing to search before SCRIPT has written a row", async () => {
    await ctx.db.insert(runs).values({ id: "r1", startedAt: "2026-08-31T10:00:00.000Z", stage: "research", status: "running", traceId: TRACE }).run();
    const fetchImpl = vi.fn(async () => pexelsResponse(1));
    vi.stubGlobal("fetch", fetchImpl);

    const montage = await getRunMontage(ctx.db, hotKv, vaultKv, MASTER_KEY_B64, PEXELS_KEY, TRACE);

    expect(montage?.videos).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
