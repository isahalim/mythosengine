import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitClipToLibrary, ensureLibraryWorktree, readClipFromLibrary, removeLibraryWorktree } from "./library.ts";

const execFileAsync = promisify(execFile);

describe("footage library (real git, isolated scratch repo)", () => {
  let repoDir: string;
  let worktreeDir: string;

  beforeEach(async () => {
    // A throwaway repo, never the actual project repo -- these tests do
    // real `git worktree add`/`git commit` and must not touch mythosengine.
    repoDir = await mkdtemp(join(tmpdir(), "footage-lib-repo-"));
    await execFileAsync("git", ["init", "--initial-branch=main", "--quiet"], { cwd: repoDir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: repoDir });
    await writeFile(join(repoDir, "README.md"), "main branch placeholder\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: repoDir });
    await execFileAsync("git", ["commit", "-m", "init", "--quiet"], { cwd: repoDir });

    worktreeDir = await mkdtemp(join(tmpdir(), "footage-lib-worktree-"));
    await rm(worktreeDir, { recursive: true, force: true }); // git worktree add requires the path not exist
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(worktreeDir, { recursive: true, force: true });
  });

  it("creates the assets-library orphan branch on first use", async () => {
    const result = await ensureLibraryWorktree(repoDir, worktreeDir);
    expect(result.ok).toBe(true);

    const { stdout: branches } = await execFileAsync("git", ["branch", "--list", "assets-library"], { cwd: repoDir });
    expect(branches).toContain("assets-library");

    // the orphan branch must not carry main's history -- one commit only,
    // and it's not the same commit as main's tip
    const { stdout: log } = await execFileAsync("git", ["log", "--oneline"], { cwd: worktreeDir });
    expect(log.trim().split("\n")).toHaveLength(1);
    const { stdout: mainSha } = await execFileAsync("git", ["rev-parse", "main"], { cwd: repoDir });
    const { stdout: branchSha } = await execFileAsync("git", ["rev-parse", "assets-library"], { cwd: repoDir });
    expect(branchSha.trim()).not.toBe(mainSha.trim());
  });

  it("reuses the existing assets-library branch on a second call (idempotent)", async () => {
    const first = await ensureLibraryWorktree(repoDir, worktreeDir);
    expect(first.ok).toBe(true);
    await removeLibraryWorktree(repoDir, worktreeDir);

    const worktreeDir2 = `${worktreeDir}-2`;
    const second = await ensureLibraryWorktree(repoDir, worktreeDir2);
    expect(second.ok).toBe(true);

    const { stdout: log } = await execFileAsync("git", ["log", "--oneline"], { cwd: worktreeDir2 });
    expect(log.trim().split("\n")).toHaveLength(1); // still just the init commit, not a second one

    await rm(worktreeDir2, { recursive: true, force: true }).catch(() => undefined);
    await execFileAsync("git", ["worktree", "remove", "--force", worktreeDir2], { cwd: repoDir }).catch(() => undefined);
  });

  it("commits a clip + metadata sidecar and returns a real commit sha", async () => {
    await ensureLibraryWorktree(repoDir, worktreeDir);

    const clipSourcePath = join(repoDir, "..", "fake-clip-source.mp4");
    await writeFile(clipSourcePath, Buffer.from("fake mp4 bytes"));

    const result = await commitClipToLibrary(worktreeDir, clipSourcePath, "clips/hollowpoiint-gta/seg1.mp4", {
      footageSourceId: "hollowpoiint-gta",
      sourceVideoId: "abc123",
      clipStartS: 100,
      clipEndS: 120,
      motionScore: 42.5,
      fetchedAt: "2026-08-28T00:00:00Z",
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.commitSha).toMatch(/^[0-9a-f]{40}$/);

    const committedBytes = await readFile(join(worktreeDir, "clips/hollowpoiint-gta/seg1.mp4"));
    expect(committedBytes.toString()).toBe("fake mp4 bytes");

    const metadata = JSON.parse(await readFile(join(worktreeDir, "clips/hollowpoiint-gta/seg1.mp4.json"), "utf8"));
    expect(metadata.sourceVideoId).toBe("abc123");

    await rm(clipSourcePath, { force: true });
  });

  it("surfaces a real git failure (nothing to commit) as a provider_error, not a throw", async () => {
    await ensureLibraryWorktree(repoDir, worktreeDir);

    const clipSourcePath = join(repoDir, "..", "fake-clip-source-2.mp4");
    await writeFile(clipSourcePath, Buffer.from("identical bytes"));

    const metadata = {
      footageSourceId: "hollowpoiint-gta",
      sourceVideoId: "abc123",
      clipStartS: 0,
      clipEndS: 20,
      motionScore: 1,
      fetchedAt: "2026-08-28T00:00:00Z",
    };

    const first = await commitClipToLibrary(worktreeDir, clipSourcePath, "clips/dup.mp4", metadata);
    expect(first.ok).toBe(true);

    // Same path, same bytes, same metadata -- nothing changes, so the
    // second commit has nothing staged and git itself fails.
    const second = await commitClipToLibrary(worktreeDir, clipSourcePath, "clips/dup.mp4", metadata);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.kind).toBe("provider_error");

    await rm(clipSourcePath, { force: true });
  });

  it("reads a committed clip's exact bytes straight out of the branch, no worktree needed for the read", async () => {
    await ensureLibraryWorktree(repoDir, worktreeDir);

    const clipSourcePath = join(repoDir, "..", "fake-clip-source-3.mp4");
    const originalBytes = Buffer.from([0x00, 0x01, 0xff, 0x42, 0x99]); // real (non-UTF8-safe) binary bytes
    await writeFile(clipSourcePath, originalBytes);
    await commitClipToLibrary(worktreeDir, clipSourcePath, "clips/read-test/seg1.mp4", {
      footageSourceId: "src1",
      sourceVideoId: "v1",
      clipStartS: 0,
      clipEndS: 20,
      motionScore: 1,
      fetchedAt: "2026-08-28T00:00:00Z",
    });

    // Read from repoDir (the "real" checkout), not the worktree -- proving
    // this doesn't need a worktree checked out to work.
    const result = await readClipFromLibrary(repoDir, "clips/read-test/seg1.mp4");
    expect(result.ok).toBe(true);
    if (result.ok) expect(Buffer.compare(result.value, originalBytes)).toBe(0);

    await rm(clipSourcePath, { force: true });
  });

  it("fails cleanly (not a throw) when the path was never committed", async () => {
    await ensureLibraryWorktree(repoDir, worktreeDir);
    const result = await readClipFromLibrary(repoDir, "clips/does/not/exist.mp4");
    expect(result.ok).toBe(false);
  });

  it("fails cleanly (not a throw) when the repo/branch doesn't exist for removeLibraryWorktree", async () => {
    const result = await removeLibraryWorktree("/definitely/not/a/real/repo", worktreeDir);
    expect(result.ok).toBe(false);
  });
});
