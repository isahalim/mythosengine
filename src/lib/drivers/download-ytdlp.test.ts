import { execSync } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { classifyYtDlpError, parseMetadata, YtDlpDownloadDriver } from "./download-ytdlp.ts";

function hasFfmpeg(): boolean {
  try {
    execSync("which ffmpeg && which ffprobe", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * A stand-in for the pinned `yt-dlp` binary, reproducing the parts of its
 * real contract this driver depends on — all of which were verified against
 * the actual binary (2026.08.19) before being written down here:
 *
 *   · `--dump-json` prints one JSON object per line on stdout
 *   · a download prints the final path via `--print after_move:filepath`
 *   · `--max-filesize` skips the video and exits **0**, printing nothing
 *   · failures exit non-zero with the explanation on stderr
 *
 * CI cannot depend on YouTube being reachable, on a residential IP, or on
 * downloading real footage, so this — not youtube.com — is what the contract
 * tests run against. The live path was exercised separately end to end
 * (2026-08-30) before these behaviours were fixed in code.
 *
 * The scenario is carried in the URL's `scenario` query parameter, the same
 * trick download-ytmp3-dom.test.ts's mock server uses for the same reason:
 * one stand-in, every case.
 */
const FAKE_YTDLP = `#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const { appendFileSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const LOG = join(__dirname, "invocations.log");

const argv = process.argv.slice(2);
const url = argv[argv.length - 1];
const scenario = new URL(url).searchParams.get("scenario") ?? "ok";
const isMetadata = argv.includes("--dump-json");
const outTemplate = argv[argv.indexOf("-o") + 1];
appendFileSync(LOG, (isMetadata ? "metadata" : "download") + "\\n");

function fail(stderr) {
  process.stderr.write(stderr);
  process.exit(1);
}

if (isMetadata) {
  if (scenario === "botcheck") fail("ERROR: [youtube] abc: Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies for the authentication.\\n");
  if (scenario === "agegated") fail("ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate for some users.\\n");
  if (scenario === "private") fail("ERROR: [youtube] abc: Private video. Sign in if you've been granted access to this video\\n");
  if (scenario === "ratelimited") fail("ERROR: Unable to download webpage: HTTP Error 429: Too Many Requests\\n");
  if (scenario === "nojson") process.exit(0);
  // Reports a duration well under any ceiling while the file written below
  // is longer — the only shape that can reach the post-probe check.
  if (scenario === "underreports") { process.stdout.write(JSON.stringify({ id: "abc", title: "Understated", duration: 0.1 }) + "\\n"); process.exit(0); }
  if (scenario === "badjson") { process.stdout.write("{not json at all\\n"); process.exit(0); }
  // A real yt-dlp can put a runtime warning on stdout ahead of the JSON.
  process.stdout.write("WARNING: [youtube] falling back\\n");
  process.stdout.write(JSON.stringify({ id: "abc", title: "A Walkthrough", duration: scenario === "long" ? 99999 : 100 }) + "\\n");
  process.exit(0);
}

// --max-filesize rejects the source: skipped, not failed. Exit 0, print nothing.
if (scenario === "toobig") process.exit(0);

const dest = outTemplate.replace("%(id)s", "abc").replace("%(ext)s", "mp4");
const args = scenario === "audioonly"
  ? ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "aac", dest]
  : ["-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10:duration=1", "-pix_fmt", "yuv420p", dest];
execFileSync("ffmpeg", args, { stdio: "ignore" });
process.stdout.write(dest + "\\n");
`;

let fakeBin: string;
let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "ytdlp-test-"));
  fakeBin = join(workDir, "fake-yt-dlp.cjs");
  await writeFile(fakeBin, FAKE_YTDLP);
  await chmod(fakeBin, 0o755);
});

function driverFor(scenario: string) {
  return {
    driver: new YtDlpDownloadDriver({ ytDlpBin: fakeBin }),
    url: `https://www.youtube.com/watch?v=abcdefghijk&scenario=${scenario}`,
  };
}

describe("parseMetadata", () => {
  it("reads the JSON object even when a warning precedes it on stdout", () => {
    const result = parseMetadata('WARNING: something\n{"id":"abc","title":"T","duration":42.5}\n');
    expect(result).toEqual({ ok: true, value: { durationS: 42.5, title: "T" } });
  });

  it("reports a missing duration as null rather than 0, so a live stream can never pass a duration ceiling", () => {
    const result = parseMetadata('{"id":"abc","title":"Live"}\n');
    expect(result.ok && result.value.durationS).toBeNull();
  });

  it("treats a zero duration as 'the source did not say'", () => {
    const result = parseMetadata('{"id":"abc","title":"T","duration":0}\n');
    expect(result.ok && result.value.durationS).toBeNull();
  });

  it("fails when there is no JSON at all", () => {
    const result = parseMetadata("WARNING: nothing here\n");
    expect(result.ok).toBe(false);
  });

  it("fails on unparseable JSON rather than guessing", () => {
    const result = parseMetadata("{not json\n");
    expect(result.ok).toBe(false);
  });
});

describe("classifyYtDlpError", () => {
  it("names the bot check specifically and does not mark it retryable", () => {
    const error = classifyYtDlpError("ERROR: Sign in to confirm you're not a bot.", new Error("exit 1"));
    expect(error.kind).toBe("provider_error");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("not trusted for automated download");
  });

  it("keeps yt-dlp's own words in every classification", () => {
    for (const stderr of ["ERROR: Private video", "ERROR: HTTP Error 429: Too Many Requests", "ERROR: something nobody predicted"]) {
      expect(classifyYtDlpError(stderr, new Error("exit 1")).message).toContain(stderr.slice(7));
    }
  });

  it("does not mistake an age gate for the bot check — they share a prefix and have opposite remedies", () => {
    // Both real messages begin "Sign in to confirm". Live run, 2026-08-30.
    const age = classifyYtDlpError("ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate for some users.", new Error("x"));
    expect(age.kind).toBe("policy_violation");
    expect(age.message).not.toContain("not trusted for automated download");
    expect(classifyYtDlpError("ERROR: [youtube] abc: Sign in to confirm you're not a bot.", new Error("x")).kind).toBe("provider_error");
  });

  it("classifies an unavailable video as a policy violation, not a transient fault", () => {
    expect(classifyYtDlpError("ERROR: Private video. Sign in...", new Error("x"))).toMatchObject({ kind: "policy_violation", retryable: false });
    expect(classifyYtDlpError("ERROR: Video unavailable", new Error("x"))).toMatchObject({ kind: "policy_violation", retryable: false });
  });

  it("classifies a 429 as rate limited and retryable", () => {
    expect(classifyYtDlpError("ERROR: HTTP Error 429: Too Many Requests", new Error("x"))).toMatchObject({ kind: "rate_limited", retryable: true });
  });

  it("says so when the binary itself is missing", () => {
    expect(classifyYtDlpError("", new Error("spawn yt-dlp ENOENT")).message).toContain("pinned yt-dlp binary");
  });

  it("reports an aborted run as a timeout", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(classifyYtDlpError("", abort).kind).toBe("timeout");
  });
});

describe("YtDlpDownloadDriver", () => {
  it("refuses a URL that isn't a YouTube watch link before running anything", async () => {
    const result = await new YtDlpDownloadDriver({ ytDlpBin: fakeBin }).fetchVideo({ url: "https://example.com/video" });
    expect(result).toMatchObject({ ok: false, error: { kind: "invalid_response" } });
  });

  it("refuses an over-long source without downloading a byte", async () => {
    const { driver, url } = driverFor("long");
    const result = await driver.fetchVideo({ url, maxDurationS: 60 });
    expect(result).toMatchObject({ ok: false, error: { kind: "policy_violation", retryable: false } });
    expect(result.ok === false && result.error.message).toContain("refusing before downloading it");
  });

  it("reports the bot check as its own failure, from the metadata call", async () => {
    const { driver, url } = driverFor("botcheck");
    const result = await driver.fetchVideo({ url });
    expect(result).toMatchObject({ ok: false, error: { kind: "provider_error", retryable: false } });
    expect(result.ok === false && result.error.message).toContain("not trusted for automated download");
  });

  it("surfaces a private video as a policy violation", async () => {
    const { driver, url } = driverFor("private");
    const result = await driver.fetchVideo({ url });
    expect(result).toMatchObject({ ok: false, error: { kind: "policy_violation" } });
  });

  it("surfaces an age-gated video as a policy violation, so the caller tries the next candidate", async () => {
    const { driver, url } = driverFor("agegated");
    const result = await driver.fetchVideo({ url });
    expect(result).toMatchObject({ ok: false, error: { kind: "policy_violation", retryable: false } });
  });

  it.runIf(hasFfmpeg())("downloads, validates and returns a real video", async () => {
    const { driver, url } = driverFor("ok");
    const result = await driver.fetchVideo({ url, maxDurationS: 600 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sourceVideoId).toBe("abcdefghijk");
    expect(result.value.durationS).toBeGreaterThan(0);
    expect((await readFile(result.value.filePath)).byteLength).toBeGreaterThan(0);
  });

  it.runIf(hasFfmpeg())("rejects a file with no video stream instead of passing it downstream", async () => {
    const { driver, url } = driverFor("audioonly");
    const result = await driver.fetchVideo({ url });
    expect(result).toMatchObject({ ok: false, error: { kind: "invalid_response" } });
    expect(result.ok === false && result.error.message).toContain("no video stream");
  });

  it("explains a clean exit that produced no file, rather than probing nothing", async () => {
    const { driver, url } = driverFor("toobig");
    const result = await driver.fetchVideo({ url });
    expect(result).toMatchObject({ ok: false, error: { kind: "policy_violation" } });
    expect(result.ok === false && result.error.message).toContain("byte ceiling");
  });

  it.runIf(hasFfmpeg())("enforces the duration ceiling again against the measured file, not only the reported one", async () => {
    // The stand-in reports 0.1s but writes a 1s file, so a 0.5s ceiling
    // passes the pre-flight check and can only be caught after probing —
    // which is the whole reason the ceiling is enforced twice.
    const { driver, url } = driverFor("underreports");
    const result = await driver.fetchVideo({ url, maxDurationS: 0.5 });
    expect(result).toMatchObject({ ok: false, error: { kind: "policy_violation" } });
    expect(result.ok === false && result.error.message).toContain("downloaded video is");
  });

  it("never invokes the download when the pre-flight duration check refuses", async () => {
    const log = join(workDir, "invocations.log");
    await writeFile(log, "");
    const { driver, url } = driverFor("long");
    await driver.fetchVideo({ url, maxDurationS: 60 });
    // The saving is the point: refusing after the transfer would cost the
    // gigabytes the ceiling exists to avoid.
    expect((await readFile(log, "utf8")).trim().split("\n")).toEqual(["metadata"]);
  });
});
