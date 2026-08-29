// Shared between youtube-search-dom.ts and download-agentic-ytmp3.ts —
// the one place that decides whether something claiming to be a YouTube
// video URL actually is one. Applied to both directions: a URL the search
// agent read off a results page, and a URL a caller hands to the download
// driver — neither is trusted until it parses as a real watch link.
const VIDEO_ID_PATTERN = /^[\w-]{6,20}$/;

export function extractYoutubeVideoId(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl, "https://www.youtube.com");
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();
  if (host !== "youtu.be" && host !== "youtube.com" && !host.endsWith(".youtube.com")) return null;

  const id = host === "youtu.be" ? url.pathname.slice(1) : url.pathname === "/watch" ? url.searchParams.get("v") : null;
  return id !== null && VIDEO_ID_PATTERN.test(id) ? id : null;
}

export function buildWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}
