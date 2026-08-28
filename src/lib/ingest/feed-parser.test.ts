import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFeed } from "./feed-parser.ts";

const fixturesDir = join(import.meta.dirname, "__fixtures__");
const readFixture = (name: string) => readFileSync(join(fixturesDir, name), "utf8");

describe("parseFeed", () => {
  it("parses a real BBC RSS 2.0 sample", () => {
    const result = parseFeed(readFixture("real-bbc-sample.xml"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
      expect(result.value[0]).toEqual({
        title: "Watch: Tracing the deadly path of the Nepal-Tibet flash flood",
        url: "https://www.bbc.co.uk/news/videos/cp80m87pez3o?at_medium=RSS&at_campaign=rss",
        publishedAt: new Date("Thu, 27 Aug 2026 16:13:39 GMT").toISOString(),
        rank: 1,
      });
      expect(result.value[1].rank).toBe(2);
    }
  });

  it("parses a real Reddit Atom sample", () => {
    const result = parseFeed(readFixture("real-reddit-sample.xml"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
      expect(result.value[0].title).toBe(
        "What are Americans surprisingly good at that people don’t give them enough credit for?",
      );
      expect(result.value[0].url).toBe(
        "https://www.reddit.com/r/AskReddit/comments/1vzwpzz/what_are_americans_surprisingly_good_at_that/",
      );
      expect(result.value[0].publishedAt).toBe(new Date("2026-08-27T15:11:47+00:00").toISOString());
    }
  });

  it("fails cleanly on malformed XML instead of throwing", () => {
    const result = parseFeed(readFixture("malformed.xml"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("invalid_response");
      expect(result.error.retryable).toBe(false);
    }
  });

  it("returns an empty array for a well-formed feed with zero items", () => {
    const result = parseFeed(readFixture("empty-feed.xml"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });

  it("fails cleanly on a document that is neither RSS nor Atom", () => {
    const result = parseFeed("<?xml version='1.0'?><notafeed><x>1</x></notafeed>");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid_response");
  });

  it("skips (does not crash on) an RSS item missing a required field", () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
      <item><title>Has a title but no link or date</title></item>
      <item><title>Complete item</title><link>https://example.com/a</link><pubDate>Thu, 27 Aug 2026 12:00:00 GMT</pubDate></item>
    </channel></rss>`;
    const result = parseFeed(xml);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0].title).toBe("Complete item");
    }
  });
});
