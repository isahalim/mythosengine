import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DriverError } from "../drivers/types.ts";
import { err, ok, type Result } from "../result.ts";

const execFileAsync = promisify(execFile);

export interface MotionSample {
  ptsTimeS: number;
  motion: number;
}

export interface MotionWindow {
  startS: number;
  score: number;
}

/**
 * Parses ffmpeg's `signalstats` + `metadata=print` output (one block per
 * sampled frame: a `frame:N pts:... pts_time:T` header, then `key=value`
 * lines) into a motion series. Pure function — verified against real
 * ffmpeg output before being written, not guessed at. `motion` is the sum
 * of YDIF/UDIF/VDIF, ffmpeg's own per-channel frame-to-frame difference
 * metric — a standard, simple motion proxy, not a perceptual "excitement"
 * model. Good enough to rank candidate windows; not claimed to be more.
 */
export function parseSignalstatsOutput(text: string): MotionSample[] {
  const samples: MotionSample[] = [];
  const blocks = text.split(/(?=frame:)/).filter((b) => b.trim().length > 0);

  for (const block of blocks) {
    const ptsMatch = /pts_time:([\d.]+)/.exec(block);
    if (!ptsMatch) continue;
    const ptsTimeS = Number(ptsMatch[1]);

    const ydif = Number(/lavfi\.signalstats\.YDIF=([\d.]+)/.exec(block)?.[1] ?? 0);
    const udif = Number(/lavfi\.signalstats\.UDIF=([\d.]+)/.exec(block)?.[1] ?? 0);
    const vdif = Number(/lavfi\.signalstats\.VDIF=([\d.]+)/.exec(block)?.[1] ?? 0);

    samples.push({ ptsTimeS, motion: ydif + udif + vdif });
  }

  return samples;
}

/**
 * Slides a `windowS`-wide window (one sample per second, per
 * parseSignalstatsOutput's sampling rate) across the series and returns the
 * top `topK` non-overlapping windows by cumulative motion, highest first.
 * Non-overlapping so candidates are genuinely different moments, not the
 * same peak reported three times.
 */
export function findTopMotionWindows(series: MotionSample[], windowS: number, topK: number): MotionWindow[] {
  if (series.length === 0) return [];

  const maxT = Math.max(...series.map((s) => s.ptsTimeS));
  const byTime = new Map(series.map((s) => [Math.round(s.ptsTimeS), s.motion]));

  const candidates: MotionWindow[] = [];
  for (let start = 0; start + windowS <= maxT; start++) {
    let score = 0;
    for (let t = start; t < start + windowS; t++) {
      score += byTime.get(t) ?? 0;
    }
    candidates.push({ startS: start, score });
  }

  candidates.sort((a, b) => b.score - a.score);

  const selected: MotionWindow[] = [];
  for (const candidate of candidates) {
    const overlaps = selected.some((s) => Math.abs(s.startS - candidate.startS) < windowS);
    if (!overlaps) selected.push(candidate);
    if (selected.length === topK) break;
  }

  return selected;
}

export interface MotionScoreOptions {
  ffmpegBin?: string;
  timeoutMs?: number;
  /** Samples per second fed into signalstats — 1 is plenty for window-level ranking. */
  sampleRateHz?: number;
}

/** Runs the actual ffmpeg subprocess and returns the parsed motion series for a video file. */
export async function computeMotionSeries(
  videoPath: string,
  options: MotionScoreOptions = {},
): Promise<Result<MotionSample[], DriverError>> {
  const ffmpegBin = options.ffmpegBin ?? "ffmpeg";
  const timeoutMs = options.timeoutMs ?? 300_000; // a full long-form video pass can be slow
  const sampleRateHz = options.sampleRateHz ?? 1;

  const dir = await mkdtemp(join(tmpdir(), "motion-score-"));
  const statsPath = join(dir, "stats.txt");

  try {
    await execFileAsync(
      ffmpegBin,
      [
        "-i",
        videoPath,
        "-vf",
        `fps=${sampleRateHz},signalstats,metadata=print:file=${statsPath}`,
        "-f",
        "null",
        "-",
      ],
      { signal: AbortSignal.timeout(timeoutMs) },
    );
  } catch (cause) {
    await rm(dir, { recursive: true, force: true });
    const message = cause instanceof Error ? cause.message : String(cause);
    const isAbort = cause instanceof Error && cause.name === "AbortError";
    if (isAbort) return err({ kind: "timeout", message, retryable: true });
    if (message.includes("ENOENT")) {
      return err({ kind: "provider_error", message: `${message} — is ffmpeg installed?`, retryable: false });
    }
    return err({ kind: "provider_error", message, retryable: true });
  }

  let statsText: string;
  try {
    statsText = await readFile(statsPath, "utf8");
  } catch (cause) {
    await rm(dir, { recursive: true, force: true });
    return err({
      kind: "invalid_response",
      message: `ffmpeg exited cleanly but wrote no stats file: ${cause instanceof Error ? cause.message : String(cause)}`,
      retryable: true,
    });
  }

  await rm(dir, { recursive: true, force: true });
  return ok(parseSignalstatsOutput(statsText));
}
