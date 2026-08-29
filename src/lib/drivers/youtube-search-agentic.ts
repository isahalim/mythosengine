import { z } from "zod";
import { launchBrowserSession, runBrowserAgentTask } from "./browser-agent-core.ts";
import { extractYoutubeVideoId } from "./youtube-url.ts";
import type { ChannelTopVideoRequest, ChannelTopVideoResponse, DriverError, LlmDriver, YoutubeSearchDriver } from "./types.ts";
import { ok, type Result } from "../result.ts";

const YOUTUBE_ORIGIN = "https://www.youtube.com";
const DEFAULT_MAX_ITERATIONS = 6;

const ResultSchema = z.object({
  videos: z
    .array(
      z.object({
        url: z.string().min(1),
        title: z.string().min(1),
        durationS: z.number().int().nonnegative().nullable(),
        viewCount: z.number().int().nonnegative().nullable(),
      }),
    )
    .max(3),
});

const SYSTEM_PROMPT = `You are a footage-discovery agent for an automated video pipeline. Your only
job this turn is to find real, existing YouTube videos matching a search —
never invent a video, title, or URL that isn't actually on the page you
navigated to. You have browser tools; use browser_list_links to get real
hrefs (browser_snapshot alone does not include URLs). Report exactly what
you found, including an empty list if the search returned nothing usable —
under-reporting is fine, fabricating is not.`;

export interface AgenticYoutubeSearchDriverOptions {
  llm: LlmDriver;
  maxIterations?: number;
  actionTimeoutMs?: number;
  /** Where to navigate for search — defaults to real youtube.com. Contract tests point this at a local fixture server; the returned candidate URLs still have to parse as real youtube.com/youtu.be watch links regardless (extractYoutubeVideoId), same as production. */
  searchOrigin?: string;
}

/**
 * Replaces the YouTube Data API v3 search (youtube-search.ts, removed) per
 * the operator's directive: agentically search
 * `"<game>" walkthrough "<channel>" youtube` directly on youtube.com and read
 * up to 3 distinct top results off the results page (ARCHITECTURE.md §5.0).
 * Preserves refreshFootageSource's "try each candidate in order, fall
 * through on a per-video failure" contract by returning a short ranked list,
 * not just the single top hit.
 *
 * durationS/viewCount here are a best-effort read of the results page, not
 * an API guarantee — unlike the old driver, there's no structured API
 * response to trust. The one authoritative, enforced duration check moved to
 * the download leg (download-agentic-ytmp3.ts), which measures the actual
 * downloaded file with ffprobe. Every candidate URL is independently
 * verified against extractYoutubeVideoId before being trusted at all — the
 * model's report is untrusted input, same as any other tool output.
 */
export class AgenticYoutubeSearchDriver implements YoutubeSearchDriver {
  constructor(private readonly options: AgenticYoutubeSearchDriverOptions) {}

  async findTopLongFormVideos(req: ChannelTopVideoRequest): Promise<Result<ChannelTopVideoResponse[], DriverError>> {
    const origin = this.options.searchOrigin ?? YOUTUBE_ORIGIN;
    const query = req.game ? `"${req.game}" walkthrough "${req.channelHandle}" youtube` : `"${req.channelHandle}" walkthrough youtube`;
    const searchUrl = `${origin}/results?search_query=${encodeURIComponent(query)}`;
    const minMinutes = Math.round(req.minDurationS / 60);

    const session = await launchBrowserSession([origin]);
    try {
      const agentResult = await runBrowserAgentTask(
        {
          llm: this.options.llm,
          page: session.page,
          allowedOrigins: [origin],
          downloadsDir: "", // this task never downloads anything
          maxIterations: this.options.maxIterations ?? DEFAULT_MAX_ITERATIONS,
          actionTimeoutMs: this.options.actionTimeoutMs,
          systemPrompt: SYSTEM_PROMPT,
          userGoal:
            `Navigate to ${searchUrl}. Read the search results (browser_snapshot for what's visible, browser_list_links for real URLs). ` +
            `Pick up to 3 distinct actual video results — not channels, not playlists, not Shorts — that plausibly run at least ${minMinutes} minutes based on the duration shown for each result. List them most-relevant-first. ` +
            `Then call report_videos with what you found (empty videos array if nothing usable is on the page).`,
        },
        {
          name: "report_videos",
          description: "Report the ranked candidate videos found on the search results page.",
          parameters: {
            type: "object",
            properties: {
              videos: {
                type: "array",
                maxItems: 3,
                items: {
                  type: "object",
                  properties: {
                    url: { type: "string" },
                    title: { type: "string" },
                    durationS: { type: ["number", "null"] },
                    viewCount: { type: ["number", "null"] },
                  },
                  required: ["url", "title", "durationS", "viewCount"],
                },
              },
            },
            required: ["videos"],
          },
          schema: ResultSchema,
        },
      );
      if (!agentResult.ok) return agentResult;

      const candidates: ChannelTopVideoResponse[] = [];
      for (const video of agentResult.value.videos) {
        const videoId = extractYoutubeVideoId(video.url);
        if (videoId === null) continue; // not a real watch URL — drop it rather than trust it
        candidates.push({
          videoId,
          title: video.title,
          durationS: video.durationS ?? req.minDurationS,
          viewCount: video.viewCount ?? 0,
        });
      }
      return ok(candidates);
    } finally {
      await session.close();
    }
  }
}
