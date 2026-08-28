export interface Env {
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      return Response.json({ ok: true });
    }

    if (url.pathname === "/readyz") {
      // D1 and KV are not provisioned yet (see PROVISIONED.md, Task 8.2) — report
      // not-ready honestly rather than a hardcoded ok.
      return Response.json(
        { ok: false, reason: "d1_kv_not_provisioned" },
        { status: 503 },
      );
    }

    return env.ASSETS.fetch(request);
  },
};
