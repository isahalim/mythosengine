import { describe, expect, it } from "vitest";
import { ArticleFetchDriver, htmlToText } from "./article-fetch.ts";

function fakeFetch(response: Response): typeof fetch {
  return (async () => response.clone()) as typeof fetch;
}

const HTML_HEADERS = { "content-type": "text/html; charset=utf-8" };

describe("htmlToText", () => {
  it("drops the contents of script and style, not just their tags", () => {
    const text = htmlToText(
      `<html><head><style>.a{color:red}</style><script>window.__DATA__={"secret":1}</script></head><body><p>Real article text.</p></body></html>`,
    );
    expect(text).toBe("Real article text.");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("color:red");
  });

  it("keeps paragraph boundaries as newlines", () => {
    expect(htmlToText("<p>One</p><p>Two</p>")).toBe("One\nTwo");
  });

  it("decodes the entities that actually show up in prose", () => {
    expect(htmlToText("<p>Rockstar&#39;s &quot;delay&quot; &amp; the fallout, 2027</p>")).toBe(
      `Rockstar's "delay" & the fallout, 2027`,
    );
  });

  it("collapses a non-breaking space into an ordinary one", () => {
    expect(htmlToText("<p>one&nbsp;two</p>")).toBe("one two");
  });

  it("strips comments, including ones containing markup", () => {
    expect(htmlToText("<p>Kept</p><!-- <p>Dropped</p> -->")).toBe("Kept");
  });

  it("returns an empty string for markup with no text", () => {
    expect(htmlToText("<html><body><div></div></body></html>")).toBe("");
  });
});

describe("ArticleFetchDriver", () => {
  it("returns the readable text of an article", async () => {
    const driver = new ArticleFetchDriver({
      fetchImpl: fakeFetch(
        new Response("<html><body><h1>Title</h1><p>Body text.</p></body></html>", { status: 200, headers: HTML_HEADERS }),
      ),
    });
    const result = await driver.fetchArticle("https://example.com/story");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.text).toContain("Body text.");
      expect(result.value.truncated).toBe(false);
    }
  });

  it("truncates at maxChars and says so", async () => {
    const driver = new ArticleFetchDriver({
      maxChars: 10,
      fetchImpl: fakeFetch(new Response(`<p>${"x".repeat(500)}</p>`, { status: 200, headers: HTML_HEADERS })),
    });
    const result = await driver.fetchArticle("https://example.com/long");
    expect(result.ok).toBe(true);
    // A caller must never mistake a cut-off article for a short one.
    if (result.ok) {
      expect(result.value.text).toHaveLength(10);
      expect(result.value.truncated).toBe(true);
    }
  });

  it.each([
    ["localhost", "http://localhost:8787/admin"],
    ["loopback", "http://127.0.0.1/admin"],
    ["RFC-1918", "http://10.0.0.5/"],
    ["another RFC-1918 range", "http://172.20.1.1/"],
    ["link-local metadata", "http://169.254.169.254/latest/meta-data/"],
    ["IPv6 loopback", "http://[::1]/"],
    [".internal", "https://vault.internal/keys"],
  ])("refuses a private-network host (%s) without issuing a request", async (_label, url) => {
    let called = false;
    const driver = new ArticleFetchDriver({
      fetchImpl: (async () => {
        called = true;
        return new Response("", { status: 200 });
      }) as typeof fetch,
    });
    const result = await driver.fetchArticle(url);
    expect(called).toBe(false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("policy_violation");
      expect(result.error.retryable).toBe(false);
    }
  });

  it("refuses a non-HTTP scheme", async () => {
    const driver = new ArticleFetchDriver({ fetchImpl: fakeFetch(new Response("", { status: 200 })) });
    const result = await driver.fetchArticle("file:///etc/passwd");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("policy_violation");
  });

  it("rejects a non-text content type instead of decoding it", async () => {
    const driver = new ArticleFetchDriver({
      fetchImpl: fakeFetch(new Response("binary", { status: 200, headers: { "content-type": "video/mp4" } })),
    });
    const result = await driver.fetchArticle("https://example.com/clip.mp4");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid_response");
  });

  it("refuses an oversized body on the declared content-length", async () => {
    const driver = new ArticleFetchDriver({
      maxBytes: 100,
      fetchImpl: fakeFetch(new Response("<p>hi</p>", { status: 200, headers: { ...HTML_HEADERS, "content-length": "999999" } })),
    });
    const result = await driver.fetchArticle("https://example.com/huge");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("content-length");
  });

  it("refuses an oversized body that declared no length at all", async () => {
    // A chunked response makes no content-length claim, so the ceiling has
    // to be re-checked against what actually arrived.
    const driver = new ArticleFetchDriver({
      maxBytes: 100,
      fetchImpl: fakeFetch(new Response(`<p>${"x".repeat(5000)}</p>`, { status: 200, headers: HTML_HEADERS })),
    });
    const result = await driver.fetchArticle("https://example.com/chunked");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("policy_violation");
      expect(result.error.message).toContain("bytes exceeds");
    }
  });

  it("reports invalid_response for a page with no readable text", async () => {
    const driver = new ArticleFetchDriver({
      fetchImpl: fakeFetch(new Response("<html><body><script>var a=1;</script></body></html>", { status: 200, headers: HTML_HEADERS })),
    });
    const result = await driver.fetchArticle("https://example.com/empty");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid_response");
  });

  it("propagates a typed HTTP error rather than an empty article", async () => {
    const driver = new ArticleFetchDriver({ fetchImpl: fakeFetch(new Response("nope", { status: 404, headers: HTML_HEADERS })) });
    const result = await driver.fetchArticle("https://example.com/gone");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("provider_error");
      expect(result.error.retryable).toBe(false);
    }
  });

  it("reports a typed error for a string that isn't a URL", async () => {
    const driver = new ArticleFetchDriver({ fetchImpl: fakeFetch(new Response("", { status: 200 })) });
    const result = await driver.fetchArticle("not a url at all");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid_response");
  });
});
