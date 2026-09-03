import { execSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  classifyConversionState,
  DomYtmp3DownloadDriver,
  parseReportedDurationS,
  qualityOptionLabel,
  type RawConversionState,
} from "./download-ytmp3-dom.ts";

function hasFfmpeg(): boolean {
  try {
    execSync("which ffmpeg && which ffprobe", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * A stand-in for media.ytmp3.gg, reproducing the state machine that was read
 * off the live page on 2026-08-29 (see `SELECTORS` in the driver): a form
 * that defaults to MP3, a custom quality dropdown backed by a hidden native
 * `<select>`, a gating consent checkbox, and — after a delay — either a
 * `#download-btn` carrying `data-url`/`data-duration`/`data-filename` or an
 * error state with `.status--error` and `#retry-btn`. The status line
 * advances while it "converts", which is what the driver polls.
 *
 * Behaviour is steered by query parameters so one page covers every case:
 *   outcome=ok|error|hang · delayMs · durationAttr · file=real|fake
 *
 * CI cannot depend on a third-party converter site staying up, or on
 * downloading real footage, so this — not ytmp3.gg — is what the contract
 * tests run against. The live site was exercised separately by hand before
 * these selectors were written down.
 */
const FIXTURE_HTML = `<!doctype html>
<html><body>
<form id="downloadForm" onsubmit="return startConversion(event)">
  <input type="text" id="videoUrl" placeholder="Paste URL or search keywords" />
  <div>
    <button type="button" class="format-btn selected" onclick="pickFormat(this)">MP3</button>
    <button type="button" class="format-btn" onclick="pickFormat(this)">MP4</button>
  </div>
  <select id="quality-select" style="position:absolute;left:-9999px">
    <option value="mp4-2160">MP4 - 4K</option>
    <option value="mp4-1440">MP4 - 2K</option>
    <option value="mp4-1080-premium">MP4 - 1080P Premium</option>
    <option value="mp4-1080" selected>MP4 - 1080P</option>
    <option value="mp4-720">MP4 - 720P</option>
    <option value="mp4-360">MP4 - 360P</option>
  </select>
  <button type="button" class="video-group-trigger" onclick="document.getElementById('quality-menu').style.display='block'"> MP4 - 1080P </button>
  <div id="quality-menu" style="display:none">
    <button type="button" class="video-group-item" onclick="pickQuality('mp4-2160', this)"> MP4 - 4K </button>
    <button type="button" class="video-group-item" onclick="pickQuality('mp4-1440', this)"> MP4 - 2K </button>
    <button type="button" class="video-group-item" onclick="pickQuality('mp4-1080-premium', this)"> MP4 - 1080P Premium </button>
    <button type="button" class="video-group-item" onclick="pickQuality('mp4-1080', this)"> MP4 - 1080P </button>
    <button type="button" class="video-group-item" onclick="pickQuality('mp4-720', this)"> MP4 - 720P </button>
    <button type="button" class="video-group-item" onclick="pickQuality('mp4-360', this)"> MP4 - 360P </button>
  </div>
  <input type="checkbox" id="copyright-consent-checkbox" />
  <button type="submit" id="submit-button">Convert</button>
</form>
<div id="service-notice-overlay" aria-modal="true" role="alertdialog" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5)">
  <div class="sn-card" style="position:fixed;inset:0">
    <p>Scheduled maintenance: conversions may be slower than usual.</p>
    <button id="sn-dismiss" onclick="document.getElementById('service-notice-overlay').style.display='none'">Got it</button>
  </div>
</div>
<div id="result" style="display:none">
  <div class="status" id="status-el"></div>
  <button id="retry-btn" style="display:none" onclick="runConversion()">Retry</button>
  <button id="download-btn" style="display:none">Download</button>
</div>
<script>
  var params = new URLSearchParams(location.search);
  // A notice=1 query param reproduces the modal the live site served the
  // Actions runner on 2026-08-31; notice=stuck serves one with no
  // recognizable dismiss control.
  if (params.get('notice')) {
    document.getElementById('service-notice-overlay').style.display = 'block';
    if (params.get('notice') === 'stuck') document.getElementById('sn-dismiss').textContent = 'Read the full announcement';
  }
  function pickFormat(btn) {
    var all = document.querySelectorAll('.format-btn');
    for (var i = 0; i < all.length; i++) all[i].className = 'format-btn';
    btn.className = 'format-btn selected';
  }
  function pickQuality(value, btn) {
    document.getElementById('quality-select').value = value;
    document.querySelector('.video-group-trigger').textContent = ' ' + btn.textContent.trim() + ' ';
    document.getElementById('quality-menu').style.display = 'none';
  }
  // How many conversions have been started. A failTimes=N query param fails
  // the first N and then succeeds, which is what makes the driver's use of
  // the page's own #retry-btn testable.
  var conversionAttempts = 0;
  function startConversion(event) {
    event.preventDefault();
    document.getElementById('downloadForm').style.display = 'none';
    runConversion();
    return false;
  }
  function runConversion() {
    conversionAttempts++;
    // Reported to the fixture's own server, same origin, before any outcome
    // branching — so a test can count conversion STARTS rather than infer
    // them from how long the driver took. The hang outcome returns early
    // below and still gets counted, which is the case that needs it most.
    fetch('/conversion-start');
    var result = document.getElementById('result');
    var status = document.getElementById('status-el');
    result.style.display = 'block';
    // Reset from any previous failure, exactly as the real page does.
    status.className = 'status';
    document.getElementById('retry-btn').style.display = 'none';
    status.textContent = 'Checking video source…';
    setTimeout(function () { status.textContent = 'Analyzing video details…'; }, 50);

    var delayMs = Number(params.get('delayMs') || '250');
    var outcome = params.get('outcome') || 'ok';
    var failTimes = Number(params.get('failTimes') || '0');
    if (outcome === 'hang') return false;

    setTimeout(function () {
      if (outcome === 'error' || conversionAttempts <= failTimes) {
        status.className = 'status status--error';
        status.textContent = 'An error occurred - please retry';
        document.getElementById('retry-btn').style.display = 'inline';
        return;
      }
      var file = params.get('file') === 'fake' ? '/files/fake.mp4' : '/files/real.mp4';
      var button = document.getElementById('download-btn');
      button.setAttribute('data-url', location.origin + file);
      button.setAttribute('data-duration', params.get('durationAttr') || '3');
      button.setAttribute('data-filename', 'Fixture Walkthrough (' + document.getElementById('quality-select').value + ').mp4');
      button.style.display = 'inline';
      status.textContent = 'Ready to download';
    }, delayMs);
    return false;
  }
</script>
</body></html>`;

const YOUTUBE_URL = "https://www.youtube.com/watch?v=abcd1234567";

describe("classifyConversionState", () => {
  const base: RawConversionState = {
    statusText: "",
    statusIsError: false,
    retryVisible: false,
    downloadVisible: false,
    downloadUrl: "",
    reportedDurationText: "",
    fileName: "",
  };

  it("is pending while the page is still working", () => {
    expect(classifyConversionState({ ...base, statusText: "Analyzing video details…" })).toEqual({
      kind: "pending",
      statusText: "Analyzing video details…",
    });
  });

  it("is ready once a visible download control carries a file URL", () => {
    const state = classifyConversionState({
      ...base,
      downloadVisible: true,
      downloadUrl: "https://files.example/output.mp4",
      reportedDurationText: "635",
      fileName: "clip.mp4",
      statusText: "Ready to download",
    });
    expect(state).toEqual({
      kind: "ready",
      statusText: "Ready to download",
      fileUrl: "https://files.example/output.mp4",
      fileName: "clip.mp4",
      reportedDurationS: 635,
    });
  });

  it("is failed when the page shows its error state", () => {
    expect(classifyConversionState({ ...base, statusIsError: true, retryVisible: true, statusText: "An error occurred - please retry" }).kind).toBe("failed");
  });

  it("stays pending for a download control that is present but has no URL yet", () => {
    expect(classifyConversionState({ ...base, downloadVisible: true }).kind).toBe("pending");
  });

  it("prefers a published file URL over a retry control left in the DOM", () => {
    expect(classifyConversionState({ ...base, retryVisible: true, downloadVisible: true, downloadUrl: "https://files.example/output.mp4" }).kind).toBe("ready");
  });
});

describe("parseReportedDurationS", () => {
  it("reads whole seconds", () => {
    expect(parseReportedDurationS("635")).toBe(635);
  });

  it("is null — never 0 — for anything unparseable, so a bad value can't pass a duration check", () => {
    for (const text of ["", "  ", "0", "-5", "12.5", "unknown", "NaN"]) {
      expect(parseReportedDurationS(text)).toBeNull();
    }
  });
});

describe("qualityOptionLabel", () => {
  it("maps option values to the labels the dropdown renders", () => {
    expect(qualityOptionLabel("mp4-1080")).toBe("MP4 - 1080P");
    expect(qualityOptionLabel("mp4-720")).toBe("MP4 - 720P");
    expect(qualityOptionLabel("mp4-1440")).toBe("MP4 - 2K");
    expect(qualityOptionLabel("mp4-2160")).toBe("MP4 - 4K");
  });

  it("rejects anything the page doesn't offer, before a browser is launched", () => {
    for (const value of ["mp3-320", "mp4-999", "1080", "", "mp4-1080-premium"]) {
      expect(qualityOptionLabel(value)).toBeNull();
    }
  });
});

describe.skipIf(!hasFfmpeg())("DomYtmp3DownloadDriver", () => {
  let dir: string;
  let realVideoPath: string;
  let server: Server;
  let baseUrl: string;
  let fileRequests: string[];
  /** One entry per conversion the fixture page actually started (its `/conversion-start` beacon). */
  let conversionStarts: number;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ytmp3-dom-test-"));
    realVideoPath = join(dir, "real.mp4");
    execSync(`ffmpeg -y -f lavfi -i "testsrc=duration=3:size=320x240:rate=10" -c:v libx264 -pix_fmt yuv420p "${realVideoPath}"`, { stdio: "ignore" });
  });

  afterEach(() => {
    server?.close();
  });

  beforeEach(async () => {
    const realVideoBytes = await readFile(realVideoPath);
    fileRequests = [];
    conversionStarts = 0;
    server = createServer((req, res) => {
      const path = (req.url ?? "").split("?")[0];
      if (path === "/conversion-start") {
        conversionStarts++;
        res.writeHead(204);
        res.end();
        return;
      }
      if (path.startsWith("/files/")) {
        fileRequests.push(path);
        res.writeHead(200, { "content-type": "video/mp4" });
        res.end(path === "/files/fake.mp4" ? "this is not actually a video, just text pretending to be one" : realVideoBytes);
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(FIXTURE_HTML);
    });
    baseUrl = await new Promise<string>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("expected a network address");
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });
  });

  const toolUrl = (query = ""): string => `${baseUrl}/tools/converter${query}`;

  it("selects MP4, waits out the conversion, downloads the file, and returns its ffprobe-measured duration", async () => {
    const driver = new DomYtmp3DownloadDriver({
      toolUrl: toolUrl("?delayMs=1200"),
      acceptCopyrightAttestation: true,
      pollIntervalMs: 100,
    });

    const result = await driver.fetchVideo({ url: YOUTUBE_URL });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sourceVideoId).toBe("abcd1234567");
      expect(result.value.durationS).toBeGreaterThan(0);
      expect((await readFile(result.value.filePath)).length).toBeGreaterThan(0);
    }
  });

  it("honours the requested video quality via the visible dropdown, not the hidden native select", async () => {
    const driver = new DomYtmp3DownloadDriver({
      toolUrl: toolUrl("?delayMs=0"),
      videoQuality: "mp4-720",
      acceptCopyrightAttestation: true,
      pollIntervalMs: 100,
    });

    const result = await driver.fetchVideo({ url: YOUTUBE_URL });

    expect(result.ok).toBe(true);
    // The fixture stamps the quality the page actually settled on into
    // data-filename, so this asserts the app's state, not just the click.
    if (result.ok) expect(result.value.filePath).toContain("abcd1234567");
    expect(fileRequests).toEqual(["/files/real.mp4"]);
  });

  it("refuses a quality the page does not offer, before launching a browser", async () => {
    const driver = new DomYtmp3DownloadDriver({ toolUrl: toolUrl(), videoQuality: "mp4-999", acceptCopyrightAttestation: true });
    const result = await driver.fetchVideo({ url: YOUTUBE_URL });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid_response");
  });

  it("reports a retryable provider_error when the page shows its error state", async () => {
    const driver = new DomYtmp3DownloadDriver({
      toolUrl: toolUrl("?outcome=error&delayMs=200"),
      acceptCopyrightAttestation: true,
      pollIntervalMs: 100,
    });

    const result = await driver.fetchVideo({ url: YOUTUBE_URL });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("provider_error");
      expect(result.error.retryable).toBe(true);
      expect(result.error.message).toContain("An error occurred");
    }
    expect(fileRequests).toEqual([]);
  });

  it("dismisses a service notice covering the form, then converts normally", async () => {
    // The live blocker on 2026-08-31: an aria-modal alertdialog over the
    // form meant every click on it timed out, and all three candidates
    // failed with "the page's layout may have changed".
    const driver = new DomYtmp3DownloadDriver({
      toolUrl: toolUrl("?notice=1&delayMs=150&durationAttr=3"),
      acceptCopyrightAttestation: true,
      pollIntervalMs: 100,
    });

    const result = await driver.fetchVideo({ url: YOUTUBE_URL });

    expect(result.ok).toBe(true);
    expect(fileRequests).toEqual(["/files/real.mp4"]);
  });

  it("leaves a notice it cannot recognize standing, and fails with the notice's own words", async () => {
    // Guessing at an unread button, or deleting a notice the service chose to
    // show, are both worse than failing with the evidence attached. What the
    // caller must never get is "the page's layout may have changed" — that
    // reading of a "Service Discontinued" banner cost three runs on
    // 2026-08-31 before anyone read the overlay.
    const driver = new DomYtmp3DownloadDriver({
      toolUrl: toolUrl("?notice=stuck&delayMs=150"),
      acceptCopyrightAttestation: true,
      actionTimeoutMs: 2_000,
      pollIntervalMs: 100,
    });

    const result = await driver.fetchVideo({ url: YOUTUBE_URL });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("provider_error");
      expect(result.error.retryable).toBe(false);
      expect(result.error.message).toContain("service notice");
      expect(result.error.message).toContain("Scheduled maintenance");
      expect(result.error.message).not.toContain("layout may have changed");
    }
    expect(fileRequests).toEqual([]);
  });

  it("takes the page up on its own retry button and recovers from a transient failure", async () => {
    // Observed live 2026-08-31: a HollowPoiint video died with "An error
    // occurred - please retry" five seconds in, and that one hiccup failed
    // the channel's whole weekly refresh. The page renders #retry-btn for
    // exactly this; the driver now clicks it.
    const driver = new DomYtmp3DownloadDriver({
      toolUrl: toolUrl("?failTimes=1&delayMs=150&durationAttr=3"),
      acceptCopyrightAttestation: true,
      pollIntervalMs: 100,
    });

    const result = await driver.fetchVideo({ url: YOUTUBE_URL });

    expect(result.ok).toBe(true);
    expect(fileRequests).toEqual(["/files/real.mp4"]);
    // The first conversion failed and the driver pressed the page's own
    // retry: two starts, not one and not three.
    expect(conversionStarts).toBe(2);
  });

  it("gives up after the configured number of conversion attempts", async () => {
    const driver = new DomYtmp3DownloadDriver({
      toolUrl: toolUrl("?outcome=error&delayMs=150"),
      acceptCopyrightAttestation: true,
      pollIntervalMs: 100,
      maxConversionAttempts: 2,
    });

    const result = await driver.fetchVideo({ url: YOUTUBE_URL });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("provider_error");
    // Retrying is bounded — a converter that keeps failing is telling us
    // something real, and must not spin the job until the Actions timeout.
    expect(conversionStarts).toBe(2);
    expect(fileRequests).toEqual([]);
  });

  it("does not retry a timeout — the conversion is still running, restarting it just spends the budget twice", async () => {
    const driver = new DomYtmp3DownloadDriver({
      toolUrl: toolUrl("?outcome=hang"),
      acceptCopyrightAttestation: true,
      conversionTimeoutMs: 1_200,
      pollIntervalMs: 100,
      maxConversionAttempts: 3,
    });

    const result = await driver.fetchVideo({ url: YOUTUBE_URL });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("timeout");
    // **One conversion start, not three**, counted at the fixture's server
    // rather than inferred from the clock.
    //
    // This used to assert `elapsed < conversionTimeoutMs * 2`, and it was
    // measuring the wrong thing: `elapsed` covers the whole of
    // `fetchVideo` — launching Chromium, navigating, filling the form —
    // and only 1.2s of that is the budget under test. A loaded two-core
    // Actions runner spent 2,743ms on a single attempt and failed CI for a
    // driver that had behaved perfectly. Wall clock cannot bound "how many
    // times did it try" when the fixed cost of everything else is not
    // itself bounded; the count can, and it is what the test is named for.
    expect(conversionStarts).toBe(1);
  });

  it("times out — rather than hanging — when the page never resolves either way", async () => {
    const driver = new DomYtmp3DownloadDriver({
      toolUrl: toolUrl("?outcome=hang"),
      acceptCopyrightAttestation: true,
      conversionTimeoutMs: 1_500,
      pollIntervalMs: 100,
    });

    const result = await driver.fetchVideo({ url: YOUTUBE_URL });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("timeout");
      expect(result.error.retryable).toBe(true);
    }
  });

  it("rejects an over-long source from the page's own reported duration, without downloading a byte", async () => {
    const driver = new DomYtmp3DownloadDriver({
      toolUrl: toolUrl("?delayMs=0&durationAttr=62735"),
      acceptCopyrightAttestation: true,
      pollIntervalMs: 100,
    });

    const result = await driver.fetchVideo({ url: YOUTUBE_URL, maxDurationS: 24_000 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("policy_violation");
      expect(result.error.retryable).toBe(false);
      expect(result.error.message).toContain("before downloading");
    }
    expect(fileRequests).toEqual([]);
  });

  it("still enforces maxDurationS against the measured file when the page under-reports the duration", async () => {
    const driver = new DomYtmp3DownloadDriver({
      toolUrl: toolUrl("?delayMs=0&durationAttr=1"),
      acceptCopyrightAttestation: true,
      pollIntervalMs: 100,
    });

    const result = await driver.fetchVideo({ url: YOUTUBE_URL, maxDurationS: 2 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("policy_violation");
      expect(result.error.message).toContain("downloaded video is");
    }
    expect(fileRequests).toEqual(["/files/real.mp4"]);
  });

  it("rejects a downloaded file that isn't a real video, instead of trusting the page", async () => {
    const driver = new DomYtmp3DownloadDriver({
      toolUrl: toolUrl("?delayMs=0&file=fake"),
      acceptCopyrightAttestation: true,
      pollIntervalMs: 100,
    });

    const result = await driver.fetchVideo({ url: YOUTUBE_URL });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid_response");
  });

  it("refuses to fill the disk: a file over maxDownloadBytes is rejected and not kept", async () => {
    const driver = new DomYtmp3DownloadDriver({
      toolUrl: toolUrl("?delayMs=0"),
      acceptCopyrightAttestation: true,
      pollIntervalMs: 100,
      maxDownloadBytes: 128,
    });

    const result = await driver.fetchVideo({ url: YOUTUBE_URL });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("policy_violation");
      expect(result.error.message).toContain("ceiling");
    }
  });

  it("refuses outright when the copyright attestation has not been enabled by the operator", async () => {
    const driver = new DomYtmp3DownloadDriver({ toolUrl: toolUrl() });
    const result = await driver.fetchVideo({ url: YOUTUBE_URL });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("policy_violation");
      expect(result.error.retryable).toBe(false);
    }
  });

  it("refuses a URL that isn't a recognizable YouTube watch link, before ever opening a browser", async () => {
    const driver = new DomYtmp3DownloadDriver({ toolUrl: toolUrl(), acceptCopyrightAttestation: true });
    const result = await driver.fetchVideo({ url: "https://not-youtube.example.com/whatever" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("invalid_response");
      expect(result.error.retryable).toBe(false);
    }
  });

  it("fails typed, not silently, when the page's form is not the shape this driver knows", async () => {
    server.close();
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><html><body><p>ytmp3 has been redesigned</p></body></html>");
    });
    baseUrl = await new Promise<string>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("expected a network address");
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });

    const driver = new DomYtmp3DownloadDriver({ toolUrl: toolUrl(), acceptCopyrightAttestation: true, actionTimeoutMs: 1_000 });
    const result = await driver.fetchVideo({ url: YOUTUBE_URL });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("invalid_response");
      expect(result.error.message).toContain("layout may have changed");
    }
  });
});
