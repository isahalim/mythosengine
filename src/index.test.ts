import { describe, expect, it } from "vitest";
import worker, { type Env } from "./index.ts";

function makeEnv(assetsResponse: Response): Env {
  const assets: Fetcher = {
    fetch: async () => assetsResponse.clone(),
    connect: () => {
      throw new Error("connect() is not used by this test");
    },
  };
  return { ASSETS: assets };
}

describe("worker fetch", () => {
  it("returns ok on /healthz", async () => {
    const res = await worker.fetch(
      new Request("https://mythosengine.example/healthz"),
      makeEnv(new Response("unused")),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("reports not ready on /readyz until D1/KV exist", async () => {
    const res = await worker.fetch(
      new Request("https://mythosengine.example/readyz"),
      makeEnv(new Response("unused")),
    );
    expect(res.status).toBe(503);
  });

  it("falls through to ASSETS for everything else", async () => {
    const assetsResponse = new Response("<html>home</html>", {
      headers: { "content-type": "text/html" },
    });
    const res = await worker.fetch(
      new Request("https://mythosengine.example/"),
      makeEnv(assetsResponse),
    );
    expect(await res.text()).toBe("<html>home</html>");
  });

  it("adds X-Robots-Tag: noindex, nofollow on every /console/* response", async () => {
    const assetsResponse = new Response("<html>console</html>", {
      headers: { "content-type": "text/html" },
    });
    const res = await worker.fetch(
      new Request("https://mythosengine.example/console/settings"),
      makeEnv(assetsResponse),
    );
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(await res.text()).toBe("<html>console</html>");
  });

  it("does not add X-Robots-Tag on the public homepage", async () => {
    const assetsResponse = new Response("<html>home</html>", {
      headers: { "content-type": "text/html" },
    });
    const res = await worker.fetch(
      new Request("https://mythosengine.example/"),
      makeEnv(assetsResponse),
    );
    expect(res.headers.get("X-Robots-Tag")).toBeNull();
  });
});
