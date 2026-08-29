import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { YtDlpDownloadDriver } from "./download-ytdlp.ts";

const fixturesDir = join(import.meta.dirname, "__fixtures__");
const fixture = (name: string) => join(fixturesDir, name);

describe("YtDlpDownloadDriver", () => {
  it("downloads and returns the file path + duration + source id", async () => {
    const driver = new YtDlpDownloadDriver({ ytDlpBin: fixture("fake-ytdlp-success.py") });
    const result = await driver.fetchVideo({ url: "https://example.com/watch?v=abc123" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.durationS).toBe(30);
      expect(result.value.sourceVideoId).toBe("abc123");
      const bytes = await readFile(result.value.filePath);
      expect(bytes.length).toBeGreaterThan(0);
    }
  });

  it("refuses (policy_violation) a video longer than maxDurationS, before any download call", async () => {
    const driver = new YtDlpDownloadDriver({ ytDlpBin: fixture("fake-ytdlp-too-long.py") });
    const result = await driver.fetchVideo({ url: "https://example.com/watch?v=long", maxDurationS: 1800 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("policy_violation");
      expect(result.error.retryable).toBe(false);
    }
  });

  it("allows a video at or under maxDurationS", async () => {
    const driver = new YtDlpDownloadDriver({ ytDlpBin: fixture("fake-ytdlp-success.py") });
    const result = await driver.fetchVideo({ url: "https://example.com/watch?v=abc123", maxDurationS: 30 });
    expect(result.ok).toBe(true);
  });

  it("fails cleanly on malformed metadata JSON", async () => {
    const driver = new YtDlpDownloadDriver({ ytDlpBin: fixture("fake-ytdlp-bad-metadata.py") });
    const result = await driver.fetchVideo({ url: "https://example.com/watch?v=x" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("invalid_response");
      expect(result.error.retryable).toBe(false);
    }
  });

  it("reports a retryable network error when the metadata call fails", async () => {
    const driver = new YtDlpDownloadDriver({ ytDlpBin: fixture("fake-ytdlp-fail.py") });
    const result = await driver.fetchVideo({ url: "https://example.com/watch?v=x" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("network");
      expect(result.error.retryable).toBe(true);
    }
  });

  it("fails cleanly when the download step produces no file", async () => {
    const driver = new YtDlpDownloadDriver({ ytDlpBin: fixture("fake-ytdlp-no-file.py") });
    const result = await driver.fetchVideo({ url: "https://example.com/watch?v=x" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("invalid_response");
      expect(result.error.retryable).toBe(true);
    }
  });

  it("passes --cookies when cookiesFile is configured, and omits it otherwise", async () => {
    const bin = fixture("fake-ytdlp-requires-cookies.py");
    const withCookies = new YtDlpDownloadDriver({ ytDlpBin: bin, cookiesFile: "/tmp/fake-cookies.txt" });
    const resultWithCookies = await withCookies.fetchVideo({ url: "https://example.com/watch?v=abc123" });
    expect(resultWithCookies.ok).toBe(true);

    const withoutCookies = new YtDlpDownloadDriver({ ytDlpBin: bin });
    const resultWithoutCookies = await withoutCookies.fetchVideo({ url: "https://example.com/watch?v=abc123" });
    expect(resultWithoutCookies.ok).toBe(false);
  });

  it("fails with a non-retryable provider_error when yt-dlp itself can't be found", async () => {
    const driver = new YtDlpDownloadDriver({ ytDlpBin: "definitely-not-a-real-binary-xyz" });
    const result = await driver.fetchVideo({ url: "https://example.com/watch?v=x" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("provider_error");
      expect(result.error.retryable).toBe(false);
    }
  });
});
