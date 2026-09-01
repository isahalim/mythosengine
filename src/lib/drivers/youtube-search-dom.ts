import type { Page } from "playwright";
import { launchBrowserSession } from "./browser-session.ts";
import { extractYoutubeVideoId } from "./youtube-url.ts";
import type { ChannelTopVideoRequest, ChannelTopVideoResponse, DriverError, YoutubeSearchDriver } from "./types.ts";
import { err, ok, type Result } from "../result.ts";

const YOUTUBE_ORIGIN = "https://www.youtube.com";
const NAVIGATION_TIMEOUT_MS = 30_000;
const RESULTS_RENDER_TIMEOUT_MS = 20_000;
const MAX_CANDIDATES = 3;

/**
 * Reading a YouTube results page is a *deterministic* problem: find the
 * result entries, read their id, title, duration and view count. It has no
 * ambiguity for a model to resolve, and the agentic driver this replaces
 * (`youtube-search-agentic.ts`) was both the most expensive part of the
 * weekly job and the part that never worked.
 *
 * What the live run on 2026-08-29 showed, once per-action logging existed:
 *
 *     [browser-agent] 1/6 browser_navigate    -> 121b
 *     [browser-agent] 2/6 browser_snapshot    -> 3290b
 *     [browser-agent] 3/6 browser_list_links  -> 340b
 *     [browser-agent] 4/6 browser_list_links  -> 340b
 *
 * 340 bytes is an empty link list. The agent was asked to pick videos off a
 * page that had none on it yet, spent four Groq calls discovering that, and
 * then reported whatever it could infer — and each of those calls carried a
 * page snapshot and the tool schemas against a tokens-per-minute quota that
 * is this tier's binding constraint. The cause was mundane: navigation
 * waited for `domcontentloaded`, and YouTube renders its results *after*
 * that, client-side.
 *
 * So this driver waits for the results to actually exist and then reads
 * them directly. Zero model calls, zero tokens, no API key, no cookies, and
 * a real failure ("no results rendered") instead of a confident guess.
 *
 * It keeps the browser: a real Chromium is what gets past the bot-check
 * that defeated `yt-dlp` (see ARCHITECTURE.md §5.0), and it is already
 * launched for the download leg. Only the *reasoning* is removed, not the
 * browser.
 *
 * Untrusted-input discipline is unchanged: every id still goes through
 * `extractYoutubeVideoId` before it is trusted, exactly as when a model
 * reported it. Scraped page data is no more trustworthy than model output.
 */
export interface DomYoutubeSearchDriverOptions {
  /** Where to navigate for search — defaults to real youtube.com. Contract tests point this at a local fixture server. */
  searchOrigin?: string;
  navigationTimeoutMs?: number;
  resultsRenderTimeoutMs?: number;
}

/** One result as read off the page, before validation. Mirrors what both extraction strategies below produce. */
interface RawResult {
  videoId: string;
  title: string;
  durationText: string | null;
  viewCountText: string | null;
}

/**
 * "1:23:45" -> 5025, "12:07" -> 727, "" / "LIVE" / null -> null.
 * A missing or unparseable duration is null, never 0 — the caller filters
 * on minDurationS, and a bogus 0 would silently drop a usable video while a
 * bogus large number would let a Short through.
 */
export function parseDurationText(text: string | null): number | null {
  if (!text) return null;
  const parts = text.trim().split(":");
  if (parts.length < 2 || parts.length > 3) return null;

  let seconds = 0;
  for (const part of parts) {
    if (!/^\d{1,2}$/.test(part.trim())) return null;
    seconds = seconds * 60 + Number(part);
  }
  return seconds;
}

/** "1.2M views" -> 1200000, "45K views" -> 45000, "1,234 views" -> 1234, unparseable -> null. */
export function parseViewCountText(text: string | null): number | null {
  if (!text) return null;
  const match = /([\d.,]+)\s*([KMB])?/i.exec(text.trim());
  if (!match) return null;

  const digits = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(digits)) return null;

  const multiplier = { k: 1_000, m: 1_000_000, b: 1_000_000_000 }[(match[2] ?? "").toLowerCase()] ?? 1;
  return Math.round(digits * multiplier);
}

/** Reads a YouTube "text" node, which is either `{simpleText}` or `{runs:[{text}]}`. */
function readTextNode(node: unknown): string | null {
  if (typeof node !== "object" || node === null) return null;
  const record: { simpleText?: unknown; runs?: unknown } = node;
  if (typeof record.simpleText === "string") return record.simpleText;
  if (Array.isArray(record.runs)) {
    return record.runs.map((run) => (typeof run === "object" && run !== null && typeof (run as { text?: unknown }).text === "string" ? (run as { text: string }).text : "")).join("");
  }
  return null;
}

/**
 * Walks YouTube's embedded `ytInitialData` and collects every
 * `videoRenderer` in it.
 *
 * Deliberately a pure function over already-fetched data rather than
 * something that runs inside `page.evaluate`: logic executed in the browser
 * context is invisible to the Node coverage instrumentation and can only be
 * exercised by standing up a real page, which is a slow and clumsy way to
 * test a tree walk. The page's only job is to hand back the blob; every
 * decision about it happens here, where it can be tested directly against
 * the shapes YouTube actually emits.
 *
 * Preferred over scraping rendered text because it carries structured
 * `lengthText`/`viewCountText` and doesn't depend on class names or whatever
 * layout experiment the account is currently in.
 */
export function collectVideoRenderers(state: unknown): RawResult[] {
  const out: RawResult[] = [];
  const seen = new Set<object>();

  const walk = (node: unknown): void => {
    if (typeof node !== "object" || node === null) return;
    // Guards against both cycles and the heavy re-traversal of shared
    // sub-objects that YouTube's state graph is full of.
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }

    const renderer: unknown = (node as { videoRenderer?: unknown }).videoRenderer;
    if (typeof renderer === "object" && renderer !== null) {
      const r: { videoId?: unknown; title?: unknown; lengthText?: unknown; viewCountText?: unknown } = renderer;
      if (typeof r.videoId === "string") {
        out.push({
          videoId: r.videoId,
          title: readTextNode(r.title) ?? "",
          durationText: readTextNode(r.lengthText),
          viewCountText: readTextNode(r.viewCountText),
        });
      }
    }

    for (const value of Object.values(node)) walk(value);
  };

  walk(state);
  return out;
}

/**
 * Hands back YouTube's own state blob from the page, untouched. The page
 * does no reasoning; `collectVideoRenderers` above does all of it in Node.
 */
async function readInitialData(page: Page): Promise<unknown> {
  return page.evaluate(() => Reflect.get(globalThis, "ytInitialData") ?? null);
}

/**
 * Fallback for when `ytInitialData` isn't present — a layout change, or the
 * local fixture server the contract test points at. Reads plain anchors,
 * which means no duration or view count; the caller treats those as unknown
 * rather than inventing them.
 */
async function extractFromAnchors(page: Page): Promise<RawResult[]> {
  const anchors = await page.locator("a[href*='/watch']").evaluateAll((elements) =>
    elements.map((el) => ({ href: el.getAttribute("href") ?? "", text: (el.textContent ?? "").trim().slice(0, 200) })),
  );

  const out: RawResult[] = [];
  for (const anchor of anchors) {
    // Resolved against the real origin so a relative "/watch?v=..." parses;
    // validated properly by extractYoutubeVideoId in the caller.
    const id = extractYoutubeVideoId(anchor.href);
    if (id !== null) out.push({ videoId: id, title: anchor.text, durationText: null, viewCountText: null });
  }
  return out;
}

/**
 * The literal string typed into YouTube's search box.
 *
 * Exported and pure so the three shapes are testable without a browser:
 * a free-form query, a channel plus its game, and a channel alone.
 */
export function buildSearchQuery(req: ChannelTopVideoRequest): string {
  const free = req.query?.trim();
  if (free !== undefined && free.length > 0) return free;
  if (req.channelHandle === undefined || req.channelHandle.length === 0) {
    throw new Error("a YouTube search needs either a query or a channelHandle");
  }
  return req.game ? `"${req.game}" walkthrough "${req.channelHandle}" youtube` : `"${req.channelHandle}" walkthrough youtube`;
}

export class DomYoutubeSearchDriver implements YoutubeSearchDriver {
  constructor(private readonly options: DomYoutubeSearchDriverOptions = {}) {}

  async findTopLongFormVideos(req: ChannelTopVideoRequest): Promise<Result<ChannelTopVideoResponse[], DriverError>> {
    const origin = this.options.searchOrigin ?? YOUTUBE_ORIGIN;
    // A planner-written query wins outright: it is already the question,
    // and folding a channel handle into it would narrow a deliberately open
    // search back down to the maintained channel (operator direction
    // 2026-09-01 opened sourcing beyond it). The channel form is unchanged
    // and is still what the weekly FOOTAGE REFRESH sends.
    const query = buildSearchQuery(req);
    const searchUrl = `${origin}/results?search_query=${encodeURIComponent(query)}`;

    const session = await launchBrowserSession([origin]);
    try {
      await session.page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: this.options.navigationTimeoutMs ?? NAVIGATION_TIMEOUT_MS });

      // The fix for the empty link list: wait for a real watch link to
      // exist before reading anything. YouTube renders results after
      // domcontentloaded, so without this the page is genuinely empty.
      // A timeout here is a real, reportable failure — not something to
      // paper over with an empty result that looks like "no matches".
      try {
        await session.page.locator("a[href*='/watch']").first().waitFor({ state: "attached", timeout: this.options.resultsRenderTimeoutMs ?? RESULTS_RENDER_TIMEOUT_MS });
      } catch {
        return err({
          kind: "invalid_response",
          message: `no search results rendered at ${searchUrl} within ${this.options.resultsRenderTimeoutMs ?? RESULTS_RENDER_TIMEOUT_MS}ms — YouTube may have served a consent wall or bot-check`,
          retryable: true,
        });
      }

      const fromState = collectVideoRenderers(await readInitialData(session.page));
      const raw = fromState.length > 0 ? fromState : await extractFromAnchors(session.page);

      // `views: null` means "the page didn't say", which is different from
      // zero views and has to survive until after sorting — hence this
      // intermediate shape rather than flattening straight into
      // ChannelTopVideoResponse (whose viewCount is a plain number).
      const scored: { video: ChannelTopVideoResponse; views: number | null }[] = [];
      const seenIds = new Set<string>();

      for (const entry of raw) {
        // Same validation the agentic driver applied to model output: page
        // content is untrusted input too.
        const videoId = extractYoutubeVideoId(`https://www.youtube.com/watch?v=${entry.videoId}`);
        if (videoId === null || seenIds.has(videoId)) continue;

        const durationS = parseDurationText(entry.durationText);
        // A known-too-short video is excluded; an unknown duration is kept
        // and left to the download leg's ffprobe check, which measures the
        // real file and is the one authoritative gate (ARCHITECTURE.md §5.0).
        if (durationS !== null && durationS < req.minDurationS) continue;

        seenIds.add(videoId);
        const views = parseViewCountText(entry.viewCountText);
        scored.push({
          video: { videoId, title: entry.title, durationS: durationS ?? req.minDurationS, viewCount: views ?? 0 },
          views,
        });
      }

      // Ranked by view count, highest first — the interface's contract.
      // Unknown view counts sort last rather than tying with genuine zeroes.
      const ranked = scored
        .sort((a, b) => (b.views ?? -1) - (a.views ?? -1))
        .slice(0, MAX_CANDIDATES)
        .map(({ video }) => video);

      return ok(ranked);
    } finally {
      await session.close();
    }
  }
}
