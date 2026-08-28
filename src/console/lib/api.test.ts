import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadExportUrl, getSummary, listExports, markExportReviewed } from "./api.ts";

// Relative same-origin paths (the whole point of this client — it never
// names a host) can't be dispatched through a real Node HTTP server the
// way src/lib/drivers/http.test.ts does, so global fetch is stubbed
// directly here instead.
describe("console api client", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GETs /console/summary with a same-origin, timed-out request", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ hello: "world" }), { status: 200 }));

    const result = await getSummary();

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/console/summary");
    expect(init.method).toBe("GET");
    expect(init.credentials).toBe("same-origin");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("never fabricates data on a failed response — returns a typed error instead", async () => {
    fetchMock.mockResolvedValue(new Response("not found", { status: 404 }));

    const result = await getSummary();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("provider_error");
      expect(result.error.retryable).toBe(false);
    }
  });

  it("returns invalid_response, not a throw, when the body isn't valid JSON", async () => {
    fetchMock.mockResolvedValue(new Response("<html>not json</html>", { status: 200 }));

    const result = await getSummary();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid_response");
  });

  it("appends a status filter to /console/exports when provided", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));

    await listExports("reviewed");

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/console/exports?status=reviewed");
  });

  it("never retries a mutation, even on a 500 — a retried mark-reviewed could double-fire", async () => {
    fetchMock.mockResolvedValue(new Response("server error", { status: 500 }));

    const result = await markExportReviewed("export-1");

    expect(result.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("builds a download URL that never needs a client-side fetch", () => {
    expect(downloadExportUrl("abc/def")).toBe("/console/exports/abc%2Fdef/download");
  });
});
