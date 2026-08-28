import { routeRequest, type RouterEnv } from "./server/router.ts";

export interface Env extends RouterEnv {
  ASSETS: Fetcher;
  YOUTUBE_API_KEY?: string;
  DISCORD_WEBHOOK_URL?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      return Response.json({ ok: true });
    }

    if (url.pathname === "/readyz") {
      try {
        await env.DB.prepare("SELECT 1").first();
        await env.HOT.get("readyz-probe");
        return Response.json({ ok: true });
      } catch (cause) {
        return Response.json({ ok: false, reason: cause instanceof Error ? cause.message : String(cause) }, { status: 503 });
      }
    }

    const apiResponse = await routeRequest(request, env);
    if (apiResponse) return apiResponse;

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
