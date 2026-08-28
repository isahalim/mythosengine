import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DriverError, TtsDriver, TtsRequest, TtsResponse, TtsWordTiming } from "./types.ts";
import { err, ok, type Result } from "../result.ts";

const execFileAsync = promisify(execFile);

/**
 * Microsoft Edge's unofficial "Read Aloud" TTS, via the WordBoundary-capable
 * `edge_tts` Python library (LGPL-3.0, github.com/rany2/edge-tts) — no key,
 * no SLA, can break without notice (ARCHITECTURE.md §0). The bare `edge-tts`
 * CLI hard-codes SentenceBoundary and has no flag for word-level timing, so
 * this shells out to scripts/edge_tts_synth.py, a thin wrapper we own that
 * requests WordBoundary explicitly.
 *
 * Deliberately a subprocess call, not an npm import: the JS ports of this
 * library are AGPL/GPL, and linking against a copyleft dependency is a
 * licensing decision for the operator, not something to introduce silently.
 * Shelling out to a separate Python process sidesteps that question
 * entirely — same pattern as the yt-dlp/ffmpeg drivers.
 */
export interface EdgeTtsDriverOptions {
  pythonBin?: string; // defaults to "python3"
  scriptPath?: string; // defaults to scripts/edge_tts_synth.py relative to repo root
  timeoutMs?: number;
  maxAttempts?: number;
}

export class EdgeTtsDriver implements TtsDriver {
  private readonly pythonBin: string;
  private readonly scriptPath: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;

  constructor(options: EdgeTtsDriverOptions = {}) {
    this.pythonBin = options.pythonBin ?? "python3";
    this.scriptPath = options.scriptPath ?? join(process.cwd(), "scripts", "edge_tts_synth.py");
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxAttempts = options.maxAttempts ?? 3;
  }

  async synthesize(req: TtsRequest): Promise<Result<TtsResponse, DriverError>> {
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const isLastAttempt = attempt === this.maxAttempts - 1;
      const result = await this.attemptOnce(req);
      if (result.ok) return result;
      if (!result.error.retryable || isLastAttempt) return result;
      await sleep(500 * 2 ** attempt);
    }
    /* v8 ignore next -- unreachable: the loop always returns on its last attempt */
    return err({ kind: "network", message: "retry loop exited unexpectedly", retryable: true });
  }

  private async attemptOnce(req: TtsRequest): Promise<Result<TtsResponse, DriverError>> {
    const dir = await mkdtemp(join(tmpdir(), "edge-tts-"));
    const audioPath = join(dir, "out.mp3");
    const timingsPath = join(dir, "out.json");

    try {
      await execFileAsync(
        this.pythonBin,
        [
          this.scriptPath,
          "--text",
          req.text,
          "--voice",
          req.voice,
          "--out-audio",
          audioPath,
          "--out-timings",
          timingsPath,
          "--rate",
          req.rate ?? "+0%",
          "--volume",
          req.volume ?? "+0%",
          "--pitch",
          req.pitch ?? "+0Hz",
        ],
        { signal: AbortSignal.timeout(this.timeoutMs) },
      );
    } catch (cause) {
      return err(classifySpawnError(cause));
    }

    let audio: Buffer;
    let timingsRaw: string;
    try {
      [audio, timingsRaw] = await Promise.all([readFile(audioPath), readFile(timingsPath, "utf8")]);
    } catch (cause) {
      return err({
        kind: "invalid_response",
        message: `edge-tts subprocess exited cleanly but output files are missing: ${cause instanceof Error ? cause.message : String(cause)}`,
        retryable: true,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    const wordTimings = parseTimings(timingsRaw);
    if (wordTimings === null) {
      return err({ kind: "invalid_response", message: "malformed word-timings JSON from edge_tts_synth.py", retryable: false });
    }

    return ok({
      audio: new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength) as Uint8Array<ArrayBuffer>,
      mimeType: "audio/mpeg",
      wordTimings,
      quotaRemaining: null,
      tokensUsed: null,
    });
  }
}

function classifySpawnError(cause: unknown): DriverError {
  const message = cause instanceof Error ? cause.message : String(cause);
  const isAbort = cause instanceof Error && cause.name === "AbortError";
  if (isAbort) {
    return { kind: "timeout", message, retryable: true };
  }
  if (message.includes("ENOENT")) {
    return {
      kind: "provider_error",
      message: `${message} — is python3 installed and is edge_tts (pip install edge-tts) available?`,
      retryable: false,
    };
  }
  // A non-zero exit from the script (network hiccup, Microsoft rejecting the
  // request) is the one genuinely retryable case.
  return { kind: "network", message, retryable: true };
}

function parseTimings(raw: string): TtsWordTiming[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const timings: TtsWordTiming[] = [];
  for (const entry of parsed) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as Record<string, unknown>).word !== "string" ||
      typeof (entry as Record<string, unknown>).offsetMs !== "number" ||
      typeof (entry as Record<string, unknown>).durationMs !== "number"
    ) {
      return null;
    }
    const e = entry as { word: string; offsetMs: number; durationMs: number };
    timings.push({ word: e.word, startMs: e.offsetMs, endMs: e.offsetMs + e.durationMs });
  }
  return timings;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
