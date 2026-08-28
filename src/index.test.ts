import { describe, expect, it } from "vitest";
import worker, { type Env } from "./index.ts";

function makeEnv(assetsResponse: Response): Env {
  const assets: Fetcher = {
    fetch: async () => assetsResponse.clone(),
    connect: () => {
      throw new Error("connect() is not used by this test");
    },
  };
  // Plain object literals structurally satisfying D1Database/KVNamespace —
  // every method always throws/rejects, since these tests never exercise a
  // real query. `Promise<never>` return types are assignable to every one
  // of KVNamespace.get's overloads, so no `as`/cast is needed anywhere here
  // (CLAUDE.md bans `as unknown as`).
  const throwingDb: D1Database = {
    prepare: () => {
      throw new Error("D1 is not provisioned in this test");
    },
    batch: async (): Promise<never> => {
      throw new Error("D1 is not provisioned in this test");
    },
    exec: async (): Promise<never> => {
      throw new Error("D1 is not provisioned in this test");
    },
    withSession: () => {
      throw new Error("D1 is not provisioned in this test");
    },
    dump: async (): Promise<never> => {
      throw new Error("D1 is not provisioned in this test");
    },
  };
  const throwingKv: KVNamespace = {
    get: async (): Promise<never> => {
      throw new Error("KV is not provisioned in this test");
    },
    put: async (): Promise<never> => {
      throw new Error("KV is not provisioned in this test");
    },
    delete: async (): Promise<never> => {
      throw new Error("KV is not provisioned in this test");
    },
    list: async (): Promise<never> => {
      throw new Error("KV is not provisioned in this test");
    },
    getWithMetadata: async (): Promise<never> => {
      throw new Error("KV is not provisioned in this test");
    },
  };
  return {
    ASSETS: assets,
    DB: throwingDb,
    HOT: throwingKv,
    VAULT: throwingKv,
    VAULT_MASTER_KEY: "unused",
    SESSION_SIGNING_KEY: "unused",
    CONSOLE_ENROLLMENT_TOKEN: "unused",
    GROQ_API_KEY: "unused",
  };
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
