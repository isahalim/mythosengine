import { describe, expect, it } from "vitest";
import { R2ExportDriver, r2ExportKey } from "./export-r2.ts";

interface Seen {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(response: () => Response, seen: Seen[]): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    return response();
  }) as unknown as typeof fetch;
}

const OPTS = { workerUrl: "https://worker.example", token: "secret-token" };
const REQ = { key: "exports/ren1.mp4", bytes: new Uint8Array([1, 2, 3, 4]) as Uint8Array<ArrayBuffer>, mimeType: "video/mp4", ttlSeconds: 259_200 };

function okBody(sizeBytes: number): Response {
  return new Response(JSON.stringify({ ok: true, key: REQ.key, sizeBytes }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("R2ExportDriver", () => {
  it("PUTs the blob to the Worker's internal export route with the shared secret", async () => {
    const seen: Seen[] = [];
    const driver = new R2ExportDriver({ ...OPTS, fetchImpl: fakeFetch(() => okBody(4), seen) });

    const result = await driver.store(REQ);

    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://worker.example/internal/exports/ren1.mp4");
    expect(seen[0].init?.method).toBe("PUT");
    const headers = seen[0].init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer secret-token");
    // Declared up front so the Worker can refuse an oversized blob before
    // reading any of it.
    expect(headers["content-length"]).toBe("4");
  });

  it("names an R2 key, which is what tells the console where to read a download from", () => {
    const driver = new R2ExportDriver(OPTS);
    expect(driver.keyFor("ren1")).toBe("exports/ren1.mp4");
    expect(r2ExportKey("ren1")).toBe("exports/ren1.mp4");
    // Deliberately NOT the legacy `export:<id>.mp4` KV shape — exports.ts
    // routes by that difference.
    expect(driver.keyFor("ren1").startsWith("exports/")).toBe(true);
  });

  it("refuses to record an export whose stored size does not match what was sent", async () => {
    const seen: Seen[] = [];
    // Silent truncation is the one failure an export must never carry into a
    // review queue: the row would look complete and the video would not be.
    const driver = new R2ExportDriver({ ...OPTS, fetchImpl: fakeFetch(() => okBody(3), seen) });

    const result = await driver.store(REQ);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("invalid_response");
    expect(result.error.message).toContain("truncated");
  });

  it("surfaces a refusal from the Worker rather than reporting a stored export", async () => {
    const seen: Seen[] = [];
    const driver = new R2ExportDriver({
      ...OPTS,
      maxAttempts: 1,
      fetchImpl: fakeFetch(() => new Response(JSON.stringify({ error: "not_configured" }), { status: 200, headers: { "content-type": "application/json" } }), seen),
    });

    const result = await driver.store(REQ);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("provider_error");
    expect(result.error.message).toContain("not_configured");
  });

  it("deletes through the same door with the same secret", async () => {
    const seen: Seen[] = [];
    const driver = new R2ExportDriver({ ...OPTS, fetchImpl: fakeFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }), seen) });

    const result = await driver.remove("exports/ren1.mp4");

    expect(result.ok).toBe(true);
    expect(seen[0].url).toBe("https://worker.example/internal/exports/ren1.mp4");
    expect(seen[0].init?.method).toBe("DELETE");
  });
});
