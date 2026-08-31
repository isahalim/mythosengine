import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

export interface BrowserSessionHandle {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

/**
 * Launches one headless Chromium page for a single footage-acquisition
 * attempt, shared by both legs of FOOTAGE REFRESH (ARCHITECTURE.md §5.0):
 * `youtube-search-dom.ts` reads a results page with it, and
 * `download-ytmp3-dom.ts` drives the converter with it.
 *
 * Popups are closed unopened (ad-site "open in new tab" is a common vector),
 * and any top-level document navigation to an origin outside
 * `allowedOrigins` is aborted before it loads — the mitigation for an ad
 * redirect trying to take the whole page somewhere else. Subresources
 * (images, scripts, ad iframes rendering) are left alone; what keeps the
 * drivers from ever acting on those is which Playwright APIs they call —
 * `getByRole`, `locator`, and `evaluate` all see only the main frame's own
 * DOM, never an `<iframe>`'s content, unless someone explicitly asks for a
 * `frameLocator()`, which nothing here does.
 *
 * Lived in `browser-agent-core.ts` until 2026-08-29, when the last
 * model-driven leg was replaced by deterministic code and that module was
 * deleted; this is the same function, unchanged, in a file that no longer
 * implies an agent is involved.
 */
export async function launchBrowserSession(allowedOrigins: readonly string[]): Promise<BrowserSessionHandle> {
  // channel: "chromium" opts into Playwright's "new headless mode" (full
  // Chromium binary) instead of the default chrome-headless-shell, which
  // handles anchor-triggered (<a download>) file downloads unreliably --
  // confirmed live: a download that always landed locally intermittently
  // never fired on a GitHub Actions runner using the default shell. This
  // also makes the drivers' real behavior against ytmp3.gg closer to an
  // actual browser, not just a test fix.
  const browser = await chromium.launch({ headless: true, channel: "chromium" });
  const context = await browser.newContext();

  // Only gate top-level document navigations (the frame has no parent) —
  // this is what stops an ad redirect from taking the whole page somewhere
  // outside allowedOrigins. Subresource/iframe-content requests pass through
  // untouched; those are contained instead by which Playwright APIs the
  // drivers ever call (see above).
  await context.route("**/*", (route) => {
    const request = route.request();
    if (request.isNavigationRequest() && request.frame().parentFrame() === null) {
      let origin: string;
      try {
        origin = new URL(request.url()).origin;
      } catch {
        return route.abort();
      }
      if (!allowedOrigins.includes(origin)) return route.abort();
    }
    return route.continue();
  });

  // context.newPage() itself fires the context's "page" event, not just a
  // real popup — registering the popup-closer before creating the primary
  // page would close the primary page out from under itself the moment it's
  // created. Create it first, then only close pages that aren't it.
  const page = await context.newPage();
  context.on("page", (popup) => {
    if (popup !== page) popup.close().catch(() => {});
  });

  return {
    browser,
    context,
    page,
    async close() {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    },
  };
}
