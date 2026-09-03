// Response shapes for the /console/* API (ARCHITECTURE.md §6), implemented
// by src/server/router.ts. Mirrors db/schema.ts column names in camelCase.
//
// Trimmed 2026-08-31 for the six-stage overhaul: the chat, voice, MCP-token
// and dashboard-summary shapes went with the routes that served them.

export type ExportStatus = "ready_for_review" | "downloaded" | "reviewed" | "discarded" | "expired";

export interface ExportListItem {
  id: string;
  renderId: string;
  sizeBytes: number;
  suggestedTitle: string;
  suggestedDescription: string;
  suggestedTags: string[];
  containsSyntheticMedia: boolean;
  createdAt: string;
  expiresAt: string;
  status: ExportStatus;
  // Denormalized render/script/footage context the review card needs
  // without a second round trip. Nullable so a partial API response still
  // renders honestly rather than inventing a value.
  footageGame: string | null;
  ttsVoice: string | null;
  scriptHook: string | null;
  durationS: number | null;
  /** Visual keywords read off the script (src/lib/pipeline/keywords.ts) — what stage 6 asks Pexels for. Empty when the script row is gone. */
  keywords: string[];
}

/**
 * One clip of a finished video, as the metadata sheet shows it — mirrors
 * `ExportClipUse` in src/server/console/exports.ts.
 *
 * The two spans are not interchangeable: `outStartS`/`outEndS` are seconds
 * of the finished short, `sourceStartS`/`sourceEndS` are seconds of the
 * source video the clip was cut from.
 */
export interface ExportClipUse {
  position: number;
  provider: string | null;
  providerClipId: string | null;
  photographer: string | null;
  searchQuery: string | null;
  beatIndex: number | null;
  outStartS: number;
  outEndS: number;
  sourceStartS: number | null;
  sourceEndS: number | null;
  pageUrl: string | null;
  linkUrl: string | null;
  edited: boolean | null;
  editToolsRun: string[];
  editSkippedReason: string | null;
}

/** Mirrors `ExportMetadata` in src/server/console/exports.ts. */
export interface ExportMetadata {
  id: string;
  renderId: string;
  suggestedTitle: string;
  suggestedDescription: string;
  tags: string[];
  hashtags: string[];
  containsSyntheticMedia: boolean;
  durationS: number | null;
  scriptHook: string | null;
  debateQuestion: string | null;
  narrationDriver: string | null;
  narrationVoice: string | null;
  narrationFallbackReason: string | null;
  captionTiming: string | null;
  ungrounded: boolean;
  researchCitations: { title: string; url: string }[];
  clips: ExportClipUse[];
  usedYoutube: boolean;
  incomplete: string[];
}

/** The topic set the API offers, in order. In step with src/server/console/ideas.ts — the server rejects anything else with 422. */
export const TOPICS = ["viral", "politics", "tech", "science", "ai", "philosophy", "concept"] as const;
export type Topic = (typeof TOPICS)[number];

export interface RankedIdea {
  signalId: string;
  title: string;
  url: string;
  sourceKind: string;
  observedAt: string;
  engagementScore: number;
  relevance: number;
  matchedTerms: number;
  /** Recency credit, 1 at this instant and halving every 12 hours — see `RECENCY_WEIGHT` in src/server/console/ideas.ts. */
  freshness: number;
  score: number;
}

/** What one stage-entry source refresh managed. Reported, not implied: a feed outage shows as "3 of 5 answered", never as a shorter list. */
export interface IdeasIngestResult {
  sourcesFetched: number;
  sourcesFailed: number;
  newSignals: number;
  degradedReason: string | null;
}

export interface QueuedPickView {
  id: string;
  planId: string;
  position: number;
  topic: string;
  signalId: string;
  /** Null when the signal row is gone — rendered as a missing title, never as a fabricated one. */
  title: string | null;
  createdAt: string;
}

interface RunStage {
  stage: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  errorClass: string | null;
}

/**
 * One shot in a video's plan, and how far it actually got.
 *
 * Every status is a row the pipeline wrote after doing the thing — PLAN
 * writes `planned`, SOURCE moves it to `searching`, `downloading`,
 * `clipped`, and RENDER to `composited`. Nothing here is predicted, which
 * is the same contract the rest of stage 5 holds to.
 */
export interface RunShot {
  position: number;
  /** The beat this shot covers; null for the opening image over the hook. */
  beatIndex: number | null;
  /** One sentence from PLAN: what this image is doing for this beat. */
  intent: string;
  /** What was typed into the search box. */
  query: string;
  source: "youtube" | "pexels";
  status: "planned" | "searching" | "downloading" | "clipped" | "composited" | "failed";
  error: string | null;
}

export interface RunVideo {
  scriptId: string;
  hook: string;
  keywords: string[];
  /** The sourcing plan. Empty until PLAN has run. */
  shots: RunShot[];
  wordCount: number;
  createdAt: string;
  renderId: string | null;
  renderStatus: string | null;
  ttsVoice: string | null;
  durationS: number | null;
  exportId: string | null;
  exportStatus: ExportStatus | null;
  suggestedTitle: string | null;
  sizeBytes: number | null;
}

/** `not_triggered` is a real state, not an error: POST /console/dispatch records a run it has no credential to actually start. */
type RunStatus = "not_triggered" | "queued" | "running" | "succeeded" | "failed";

export interface RunProgress {
  traceId: string;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  stages: RunStage[];
  videos: RunVideo[];
  note: string | null;
}

/**
 * A preview clip for the forge — retrieved from Pexels for one of the
 * script's keywords, for the hover reveal inside the glass.
 *
 * A PREVIEW, which is not the same thing as the footage: the shot plan
 * (`RunShot`) is what says where a video's real footage came from, and the
 * export's audit package is what proves it per clip. The UI keeps the
 * attribution visible either way.
 */
export interface MontageClip {
  id: number;
  keyword: string;
  videoUrl: string;
  thumbnailUrl: string;
  durationS: number;
  width: number;
  height: number;
  photographer: string;
  sourceUrl: string;
}

export interface RunMontage {
  traceId: string;
  configured: boolean;
  videos: { scriptId: string; keywords: string[]; clips: MontageClip[] }[];
  failures: { keyword: string; error: string }[];
}

/**
 * The same preview clips, for work that has already finished — stage 6
 * reaches past work without a trace id in hand, so it cannot go through the
 * run montage. Preview ONLY, on exactly the same terms as `MontageClip`.
 */
export interface ExportPreviews {
  configured: boolean;
  exports: { exportId: string; keywords: string[]; clips: MontageClip[] }[];
  failures: { keyword: string; error: string }[];
}
