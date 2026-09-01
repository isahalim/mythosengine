import { mkdtemp, rm, stat, utimes, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CACHE_DIR, findCachedSource, MAX_AGE_MS, reserveCacheSlot, sweepSourceCache } from "./source-cache.ts";

const NOW = Date.parse("2026-09-01T12:00:00.000Z");
const now = () => NOW;

describe("the 24h source cache", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "cache-test-"));
    await mkdir(join(repoDir, CACHE_DIR), { recursive: true });
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  async function seed(videoId: string, ageMs: number, bytes = 1024): Promise<string> {
    const path = join(repoDir, CACHE_DIR, `${videoId}.mp4`);
    await writeFile(path, Buffer.alloc(bytes));
    const when = new Date(NOW - ageMs);
    await utimes(path, when, when);
    return path;
  }

  it("returns a source downloaded within the window", async () => {
    const path = await seed("dQw4w9WgXcQ", 3 * 60 * 60 * 1000);
    expect(await findCachedSource(repoDir, "dQw4w9WgXcQ", now)).toBe(path);
  });

  it("treats a source older than the window as absent", async () => {
    await seed("dQw4w9WgXcQ", MAX_AGE_MS + 1000);
    expect(await findCachedSource(repoDir, "dQw4w9WgXcQ", now)).toBeNull();
  });

  it("treats a zero-byte file as absent, not as a hit", async () => {
    // A download that died mid-flight leaves one of these, and reusing it
    // would hand ffmpeg an empty file three stages later.
    await seed("dQw4w9WgXcQ", 1000, 0);
    expect(await findCachedSource(repoDir, "dQw4w9WgXcQ", now)).toBeNull();
  });

  it("reports a miss for a video never downloaded", async () => {
    expect(await findCachedSource(repoDir, "neverSeenId", now)).toBeNull();
  });

  it("refuses to build a path from an implausible video id", async () => {
    // The id is validated upstream, but this builds a filesystem path from
    // it, so it is re-checked rather than trusted.
    await expect(reserveCacheSlot(repoDir, "../../etc/passwd")).rejects.toThrow("implausible video id");
  });

  it("sweeps what is past the window and leaves what is not", async () => {
    await seed("oldVideoAAA", MAX_AGE_MS + 60_000, 2048);
    await seed("newVideoBBB", 60_000, 4096);

    const result = await sweepSourceCache(repoDir, now);

    expect(result.removed).toBe(1);
    expect(result.bytesFreed).toBe(2048);
    expect(await findCachedSource(repoDir, "newVideoBBB", now)).not.toBeNull();
    await expect(stat(join(repoDir, CACHE_DIR, "oldVideoAAA.mp4"))).rejects.toThrow();
  });

  it("sweeps a cache that does not exist yet without complaining", async () => {
    const empty = await mkdtemp(join(tmpdir(), "cache-empty-"));
    expect(await sweepSourceCache(empty, now)).toEqual({ removed: 0, bytesFreed: 0 });
    await rm(empty, { recursive: true, force: true });
  });
});
