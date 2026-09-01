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
  score: number;
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

export interface RunVideo {
  scriptId: string;
  hook: string;
  keywords: string[];
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
 * script's keywords. Preview ONLY: the rendered video's footage comes from
 * the maintained, provenance-tracked library and these clips never enter
 * it. The UI must keep saying so, and must keep the attribution visible.
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
