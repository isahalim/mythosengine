#!/usr/bin/env node
/**
 * Turns a rendered export into the landing page's demo asset.
 *
 * The landing demo (`src/app/stages/LandingDemo.tsx`) ends on a real video
 * this pipeline produced. That is the point of it — a landing page for a
 * system whose whole argument is "every render ships with its receipts"
 * cannot itself ship a mock — so this script exists to make refreshing that
 * asset a repeatable step rather than a half-remembered ffmpeg line.
 *
 * Two things happen here, and both are about the file being served to every
 * visitor from the Worker's static assets:
 *
 * - **It is re-encoded, hard.** A finished Short is 1080x1920 and 34-60 MB.
 *   That is correct for YouTube and indefensible for a landing page: it goes
 *   into the git history, and it is downloaded by anyone who presses play on
 *   a phone. The pane it plays in is ~260 CSS pixels wide, so 540x960 is
 *   still comfortably retina there, and CRF 32 with a 64k mono AAC track
 *   brings a two-minute Short from ~54 MB to ~5. 720p/CRF 30 was tried first
 *   and came out at 15 MB, which is not a landing page asset.
 * - **A poster frame comes with it.** `preload="none"` means the browser
 *   fetches no video bytes until the reader asks, so without a poster the
 *   assembled glass frames a black rectangle — which is exactly what the
 *   payoff of a five-screen scroll should not be.
 *
 * Usage:  node scripts/make-demo-asset.mjs <path-to-export.mp4>
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

const source = process.argv[2];
if (!source) {
  console.error("usage: node scripts/make-demo-asset.mjs <path-to-export.mp4>");
  process.exit(1);
}

const OUT_DIR = join("public", "demo");
const VIDEO = join(OUT_DIR, "demo-short.mp4");
const POSTER = join(OUT_DIR, "demo-short.jpg");

mkdirSync(OUT_DIR, { recursive: true });

const run = (args) => execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], { stdio: "inherit" });

run([
  "-i", source,
  "-vf", "scale=540:960:flags=lanczos",
  "-c:v", "libx264", "-crf", "32", "-preset", "slower", "-profile:v", "high", "-pix_fmt", "yuv420p",
  // Playable the instant the first bytes land, rather than after the whole
  // file — the moov atom is at the front.
  "-movflags", "+faststart",
  // Mono: it is one narrator over stock footage, and stereo is ~600 KB of
  // this file for nothing.
  "-c:a", "aac", "-b:a", "64k", "-ac", "1",
  VIDEO,
]);

// A frame from a little way in: frame 0 of a Short is often a fade or the
// first caption mid-word.
run(["-ss", "2.5", "-i", VIDEO, "-frames:v", "1", "-q:v", "4", POSTER]);

const mb = (p) => (statSync(p).size / 1e6).toFixed(2);
console.log(`demo asset: ${VIDEO} (${mb(VIDEO)} MB), poster ${POSTER} (${mb(POSTER)} MB)`);
