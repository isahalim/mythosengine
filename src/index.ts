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

    const assetResponse = await env.ASSETS.fetch(request);

    // The console is never public — noindex/nofollow at the header level
    // too, not just the <meta> tag in ConsoleLayout.astro (CONSOLE_SPEC.md:
    // "noindex, nofollow + X-Robots-Tag, excluded from any sitemap").
    if (url.pathname === "/console" || url.pathname.startsWith("/console/")) {
      const headers = new Headers(assetResponse.headers);
      headers.set("X-Robots-Tag", "noindex, nofollow");
      return new Response(assetResponse.body, { status: assetResponse.status, headers });
    }

    return assetResponse;
  },
};
