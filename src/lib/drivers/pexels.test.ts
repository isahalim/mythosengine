import { describe, expect, it } from "vitest";
import { PexelsDriver } from "./pexels.ts";

function fakeFetch(response: Response, onRequest?: (url: string, init?: RequestInit) => void): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    onRequest?.(url, init);
    return response.clone();
  }) as unknown as typeof fetch;
}

function videoPayload(overrides: Record<string, unknown> = {}) {
  return {
    videos: [
      {
        id: 8765,
        url: "https://www.pexels.com/video/a-clip-8765/",
        image: "https://images.pexels.com/videos/8765/thumb.jpg",
        duration: 12,
        user: { name: "A Photographer" },
        video_files: [
          { link: "https://player.pexels.com/8765-240.mp4", file_type: "video/mp4", width: 240, height: 426 },
          { link: "https://player.pexels.com/8765-720.mp4", file_type: "video/mp4", width: 720, height: 1280 },
          { link: "https://player.pexels.com/8765-2160.mp4", file_type: "video/mp4", width: 2160, height: 3840 },
        ],
        ...overrides,
      },
    ],
  };
}

const JSON_HEADERS = { "content-type": "application/json" };

describe("PexelsDriver", () => {
  it("returns the smallest rendition at least 640px wide, not the first or the largest", async () => {
    const driver = new PexelsDriver("key", { fetchImpl: fakeFetch(new Response(JSON.stringify(videoPayload()), { status: 200, headers: JSON_HEADERS })) });

    const result = await driver.searchVideos("rain on glass");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0].videoUrl).toBe("https://player.pexels.com/8765-720.mp4");
    expect(result.value[0].photographer).toBe("A Photographer");
    expect(result.value[0].sourceUrl).toBe("https://www.pexels.com/video/a-clip-8765/");
  });

  it("sends the key as a bare Authorization header and asks for portrait clips", async () => {
    let seenUrl = "";
    let seenAuth: string | undefined;
    const driver = new PexelsDriver("pexels-key", {
      fetchImpl: fakeFetch(new Response(JSON.stringify({ videos: [] }), { status: 200, headers: JSON_HEADERS }), (url, init) => {
        seenUrl = url;
        seenAuth = (init?.headers as Record<string, string> | undefined)?.authorization;
      }),
    });

    await driver.searchVideos("neon city");

    expect(seenAuth).toBe("pexels-key");
    expect(seenUrl).toContain("query=neon%20city");
    expect(seenUrl).toContain("orientation=portrait");
  });

  it("drops a clip with no usable attribution rather than defaulting one in", async () => {
    const driver = new PexelsDriver("key", {
      fetchImpl: fakeFetch(new Response(JSON.stringify(videoPayload({ user: null })), { status: 200, headers: JSON_HEADERS })),
    });

    const result = await driver.searchVideos("anything");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  it("drops a clip whose only renditions are not mp4", async () => {
    const driver = new PexelsDriver("key", {
      fetchImpl: fakeFetch(
        new Response(
          JSON.stringify(videoPayload({ video_files: [{ link: "https://player.pexels.com/8765.webm", file_type: "video/webm", width: 720, height: 1280 }] })),
          { status: 200, headers: JSON_HEADERS },
        ),
      ),
    });

    const result = await driver.searchVideos("anything");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  it("refuses an empty query instead of spending a request on it", async () => {
    let called = false;
    const driver = new PexelsDriver("key", {
      fetchImpl: fakeFetch(new Response("{}", { status: 200, headers: JSON_HEADERS }), () => {
        called = true;
      }),
    });

    const result = await driver.searchVideos("   ");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("policy_violation");
    expect(called).toBe(false);
  });

  it("reports a non-JSON body as invalid_response", async () => {
    const driver = new PexelsDriver("key", { fetchImpl: fakeFetch(new Response("<html>rate limited</html>", { status: 200, headers: { "content-type": "text/html" } })) });

    const result = await driver.searchVideos("anything");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("invalid_response");
  });

  it("reports a payload with no videos array as invalid_response", async () => {
    const driver = new PexelsDriver("key", { fetchImpl: fakeFetch(new Response(JSON.stringify({ error: "nope" }), { status: 200, headers: JSON_HEADERS })) });

    const result = await driver.searchVideos("anything");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("invalid_response");
  });
});
