import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSearchQuery, collectVideoRenderers, DomYoutubeSearchDriver, parseDurationText, parseViewCountText } from "./youtube-search-dom.ts";

/**
 * The fixture renders results *after* domcontentloaded, exactly as
 * youtube.com does. That timing is the whole point: the agentic driver this
 * replaced read the page too early and got an empty link list (340 bytes,
 * confirmed live 2026-08-29), so a test that serves results in the initial
 * HTML would pass while the real thing failed.
 */
const RESULTS_PAGE_HTML = `<!doctype html>
<html><body>
<div id="results"></div>
<script>
  setTimeout(function () {
    window.ytInitialData = {
      contents: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: [
        { videoRenderer: { videoId: "aaaaaaaaaaa", title: { runs: [{ text: "Long Walkthrough Part 1" }] },
          lengthText: { simpleText: "1:05:00" }, viewCountText: { simpleText: "1.2M views" } } },
        { videoRenderer: { videoId: "bbbbbbbbbbb", title: { simpleText: "Longer Walkthrough" },
          lengthText: { simpleText: "2:10:30" }, viewCountText: { simpleText: "450K views" } } },
        { videoRenderer: { videoId: "ccccccccccc", title: { simpleText: "A Short" },
          lengthText: { simpleText: "0:45" }, viewCountText: { simpleText: "9,001 views" } } },
        { videoRenderer: { videoId: "aaaaaaaaaaa", title: { simpleText: "Duplicate of the first" },
          lengthText: { simpleText: "1:05:00" }, viewCountText: { simpleText: "1.2M views" } } }
      ] } }] } }
    };
    var a = document.createElement("a");
    a.href = "/watch?v=aaaaaaaaaaa";
    a.textContent = "Long Walkthrough Part 1";
    document.getElementById("results").appendChild(a);
  }, 300);
</script>
</body></html>`;

/** No results ever render — the consent-wall / bot-check shape. */
const EMPTY_PAGE_HTML = `<!doctype html><html><body><div>No results here, ever.</div></body></html>`;

function startFixtureServer(html: string): { server: Server; baseUrl: Promise<string> } {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(html);
  });
  const baseUrl = new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("expected a network address");
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
  return { server, baseUrl };
}

describe("parseDurationText", () => {
  it("parses hh:mm:ss and mm:ss", () => {
    expect(parseDurationText("1:23:45")).toBe(5025);
    expect(parseDurationText("12:07")).toBe(727);
    expect(parseDurationText("0:45")).toBe(45);
  });

  it("returns null rather than 0 for anything it cannot parse", () => {
    // 0 would read as a real duration and silently drop a usable video.
    for (const input of [null, "", "LIVE", "Premiere", "1:2:3:4", "abc", "1:xx"]) {
      expect(parseDurationText(input)).toBeNull();
    }
  });
});

describe("parseViewCountText", () => {
  it("expands K/M/B suffixes and strips separators", () => {
    expect(parseViewCountText("1.2M views")).toBe(1_200_000);
    expect(parseViewCountText("45K views")).toBe(45_000);
    expect(parseViewCountText("1,234 views")).toBe(1234);
    expect(parseViewCountText("2B views")).toBe(2_000_000_000);
  });

  it("returns null for text with no number in it", () => {
    expect(parseViewCountText(null)).toBeNull();
    expect(parseViewCountText("No views")).toBeNull();
  });
});

describe("collectVideoRenderers", () => {
  it("finds renderers at any depth and reads both text-node shapes", () => {
    const state = {
      contents: {
        sectionListRenderer: {
          contents: [
            { itemSectionRenderer: { contents: [{ videoRenderer: { videoId: "aaa", title: { runs: [{ text: "Part " }, { text: "One" }] }, lengthText: { simpleText: "1:05:00" }, viewCountText: { simpleText: "1.2M views" } } }] } },
          ],
        },
      },
    };
    expect(collectVideoRenderers(state)).toEqual([
      { videoId: "aaa", title: "Part One", durationText: "1:05:00", viewCountText: "1.2M views" },
    ]);
  });

  it("returns an empty list for null, primitives, and a blob with no renderers in it", () => {
    for (const input of [null, undefined, 42, "a string", {}, { contents: [] }]) {
      expect(collectVideoRenderers(input)).toEqual([]);
    }
  });

  it("tolerates missing title/duration/views without inventing values", () => {
    const state = { a: { videoRenderer: { videoId: "bbb" } } };
    expect(collectVideoRenderers(state)).toEqual([{ videoId: "bbb", title: "", durationText: null, viewCountText: null }]);
  });

  it("skips a renderer with no string videoId rather than emitting a broken entry", () => {
    expect(collectVideoRenderers({ a: { videoRenderer: { videoId: 123 } }, b: { videoRenderer: {} } })).toEqual([]);
  });

  it("terminates on a cyclic graph instead of recursing forever", () => {
    const cyclic: Record<string, unknown> = { videoRenderer: { videoId: "ccc", title: { simpleText: "Loop" } } };
    cyclic.self = cyclic;
    cyclic.nested = { back: cyclic };
    expect(collectVideoRenderers(cyclic)).toEqual([{ videoId: "ccc", title: "Loop", durationText: null, viewCountText: null }]);
  });

  it("ignores malformed runs entries instead of throwing", () => {
    const state = { a: { videoRenderer: { videoId: "ddd", title: { runs: [{ text: "ok" }, null, { notText: 1 }] } } } };
    expect(collectVideoRenderers(state)[0].title).toBe("ok");
  });
});

describe("DomYoutubeSearchDriver", () => {
  let fixture: ReturnType<typeof startFixtureServer>;
  let baseUrl: string;

  afterEach(() => {
    fixture.server.close();
  });

  describe("against a page that renders results client-side", () => {
    beforeEach(async () => {
      fixture = startFixtureServer(RESULTS_PAGE_HTML);
      baseUrl = await fixture.baseUrl;
    });

    it("waits for client-rendered results, ranks by view count, and drops shorts and duplicates", async () => {
      const driver = new DomYoutubeSearchDriver({ searchOrigin: baseUrl });
      const result = await driver.findTopLongFormVideos({ channelHandle: "SomeChannel", minDurationS: 1200, game: "gta-v" });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // The 0:45 Short is below minDurationS; the repeated id appears once.
      expect(result.value.map((v) => v.videoId)).toEqual(["aaaaaaaaaaa", "bbbbbbbbbbb"]);
      // Highest view count first, not page order.
      expect(result.value[0].viewCount).toBe(1_200_000);
      expect(result.value[1].viewCount).toBe(450_000);
      expect(result.value[0].durationS).toBe(3900);
      expect(result.value[0].title).toBe("Long Walkthrough Part 1");
    });

    it("makes no model call at all — there is no LlmDriver to pass it", () => {
      // Constructing it takes no llm, which is the point: this leg's Groq
      // cost is structurally zero, not merely small.
      const driver = new DomYoutubeSearchDriver({ searchOrigin: baseUrl });
      expect(driver).toBeInstanceOf(DomYoutubeSearchDriver);
    });
  });

  describe("against a page where results never appear", () => {
    beforeEach(async () => {
      fixture = startFixtureServer(EMPTY_PAGE_HTML);
      baseUrl = await fixture.baseUrl;
    });

    it("reports a real failure instead of an empty list that reads as 'no matches'", async () => {
      const driver = new DomYoutubeSearchDriver({ searchOrigin: baseUrl, resultsRenderTimeoutMs: 1000 });
      const result = await driver.findTopLongFormVideos({ channelHandle: "SomeChannel", minDurationS: 1200 });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("no search results rendered");
      // Retryable: a consent wall or bot-check is transient, unlike "this
      // channel genuinely has no long videos".
      expect(result.error.retryable).toBe(true);
    });
  });
});

describe("buildSearchQuery", () => {
  it("uses a planner's query verbatim, without folding a channel into it", () => {
    // Sourcing was opened beyond the maintained channel on 2026-09-01.
    // Appending a handle here would silently narrow a deliberately open
    // search straight back down to it.
    expect(buildSearchQuery({ query: "GTA 6 walkthrough gameplay", minDurationS: 300, channelHandle: "HollowPoiint", game: "gta" })).toBe(
      "GTA 6 walkthrough gameplay",
    );
  });

  it("still builds the channel-scoped query the weekly refresh sends", () => {
    expect(buildSearchQuery({ channelHandle: "HollowPoiint", game: "gta", minDurationS: 300 })).toBe('"gta" walkthrough "HollowPoiint" youtube');
    expect(buildSearchQuery({ channelHandle: "HollowPoiint", minDurationS: 300 })).toBe('"HollowPoiint" walkthrough youtube');
  });

  it("ignores an empty query rather than searching for nothing", () => {
    expect(buildSearchQuery({ query: "   ", channelHandle: "HollowPoiint", minDurationS: 300 })).toBe('"HollowPoiint" walkthrough youtube');
  });

  it("refuses a request that names neither a query nor a channel", () => {
    expect(() => buildSearchQuery({ minDurationS: 300 })).toThrow("needs either a query or a channelHandle");
  });
});
