import { execFile } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { DriverError } from "../drivers/types.ts";
import { err, ok, type Result } from "../result.ts";

const execFileAsync = promisify(execFile);

export interface LibraryClipMetadata {
  footageSourceId: string;
  sourceVideoId: string;
  clipStartS: number;
  clipEndS: number;
  motionScore: number;
  fetchedAt: string;
}

export interface LibraryOptions {
  gitBin?: string;
  timeoutMs?: number;
}

async function git(repoDir: string, args: string[], options: LibraryOptions = {}): Promise<Result<string, DriverError>> {
  try {
    const { stdout } = await execFileAsync(options.gitBin ?? "git", args, {
      cwd: repoDir,
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
    return ok(stdout);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const isAbort = cause instanceof Error && cause.name === "AbortError";
    return err({ kind: isAbort ? "timeout" : "provider_error", message, retryable: isAbort });
  }
}

/**
 * Ensures the `assets-library` orphan branch exists and is checked out at
 * `worktreeDir` via `git worktree` — isolated from the caller's actual
 * working tree/branch, so this never disrupts an operator's in-progress
 * work (ARCHITECTURE.md §2/§5.0: the footage library lives on a git orphan
 * branch, not object storage).
 */
export async function ensureLibraryWorktree(
  repoDir: string,
  worktreeDir: string,
  branchName = "assets-library",
  options: LibraryOptions = {},
): Promise<Result<void, DriverError>> {
  const branchExists = await git(repoDir, ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], options);

  if (branchExists.ok) {
    const worktreeResult = await git(repoDir, ["worktree", "add", worktreeDir, branchName], options);
    return worktreeResult.ok ? ok(undefined) : worktreeResult;
  }

  // Branch doesn't exist yet: create the worktree on a detached orphan
  // commit, which also creates the branch.
  const addResult = await git(repoDir, ["worktree", "add", "--detach", worktreeDir], options);
  if (!addResult.ok) return addResult;

  const orphanResult = await git(worktreeDir, ["checkout", "--orphan", branchName], options);
  if (!orphanResult.ok) return orphanResult;

  const rmResult = await git(worktreeDir, ["rm", "-rf", "--quiet", "."], options);
  // An empty orphan tree has nothing to remove -- that's fine, not an error.
  void rmResult;

  const readmePath = join(worktreeDir, "README.md");
  await writeFile(
    readmePath,
    "# assets-library\n\nFootage clip library (ARCHITECTURE.md §5.0). Written by the weekly FOOTAGE REFRESH job. Do not edit by hand.\n",
  );
  const addFileResult = await git(worktreeDir, ["add", "README.md"], options);
  if (!addFileResult.ok) return addFileResult;

  const commitResult = await git(worktreeDir, ["commit", "-m", "chore: initialize assets-library"], options);
  return commitResult.ok ? ok(undefined) : commitResult;
}

/**
 * Copies a clip into the library worktree at a deterministic path, writes
 * its provenance metadata as a JSON sidecar, and commits both — locally
 * only. Pushing is a separate, explicit step (the same caution as any
 * other action visible to others), not something this function does.
 */
export async function commitClipToLibrary(
  worktreeDir: string,
  clipSourcePath: string,
  libraryRelativePath: string,
  metadata: LibraryClipMetadata,
  options: LibraryOptions = {},
): Promise<Result<{ commitSha: string }, DriverError>> {
  const destPath = join(worktreeDir, libraryRelativePath);
  await mkdir(dirname(destPath), { recursive: true });
  await copyFile(clipSourcePath, destPath);
  await writeFile(`${destPath}.json`, JSON.stringify(metadata, null, 2));

  const addResult = await git(worktreeDir, ["add", libraryRelativePath, `${libraryRelativePath}.json`], options);
  if (!addResult.ok) return addResult;

  const commitMessage = `feat(${metadata.footageSourceId}): clip [video:${metadata.sourceVideoId}] [${metadata.clipStartS}-${metadata.clipEndS}s]`;
  // Committed by pathspec, never as "whatever is staged". A caller that
  // fails between `add` and `commit` moves on to the next clip
  // (refreshFootageSource does exactly that), leaving these paths sitting in
  // the index — and a bare `git commit` would then sweep that abandoned clip
  // into the *next* clip's commit. Observed live on 2026-08-30: a third clip
  // reached the assets-library branch inside another clip's commit, with no
  // `footage_segments` row and no provenance anywhere pointing at it. A clip
  // in the library that the database has never heard of is exactly the kind
  // of unaccounted footage this system is not allowed to have.
  const commitResult = await git(worktreeDir, ["commit", "-m", commitMessage, "--", libraryRelativePath, `${libraryRelativePath}.json`], options);
  if (!commitResult.ok) return commitResult;

  const shaResult = await git(worktreeDir, ["rev-parse", "HEAD"], options);
  if (!shaResult.ok) return shaResult;

  return ok({ commitSha: shaResult.value.trim() });
}

/**
 * Reads one committed clip's bytes straight out of the `assets-library`
 * branch via `git show <branch>:<path>` — no worktree needed for a single
 * read. RENDER (ARCHITECTURE.md §5.7) needs this because
 * `claimNextFootageSegment`'s `libraryPath` is a path inside that branch,
 * not a file that exists in the caller's actual checked-out working tree.
 */
export async function readClipFromLibrary(
  repoDir: string,
  libraryRelativePath: string,
  branchName = "assets-library",
  options: LibraryOptions = {},
): Promise<Result<Buffer, DriverError>> {
  try {
    const { stdout } = await execFileAsync(options.gitBin ?? "git", ["show", `${branchName}:${libraryRelativePath}`], {
      cwd: repoDir,
      encoding: "buffer",
      maxBuffer: 500 * 1024 * 1024,
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
    return ok(stdout);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const isAbort = cause instanceof Error && cause.name === "AbortError";
    return err({ kind: isAbort ? "timeout" : "provider_error", message, retryable: isAbort });
  }
}

/** Removes a worktree added by ensureLibraryWorktree, once the caller is done with it. */
export async function removeLibraryWorktree(
  repoDir: string,
  worktreeDir: string,
  options: LibraryOptions = {},
): Promise<Result<void, DriverError>> {
  const result = await git(repoDir, ["worktree", "remove", "--force", worktreeDir], options);
  return result.ok ? ok(undefined) : result;
}
