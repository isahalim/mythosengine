// Response/request shapes for the /console/* API (ARCHITECTURE.md §6).
// Mirrors db/schema.ts column names in camelCase. The Worker routes these
// types describe are Phase 8 work — this file is the contract the console
// UI is built against, same "define the shape before the backend exists"
// order every driver in src/lib/drivers/** already used.

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
  // Denormalized render/script/footage context the review row needs to
  // display without a second round trip. Exact join shape is Phase 8's
  // call — kept nullable so a partial API response still renders honestly.
  footageGame: string | null;
  ttsVoice: string | null;
  scriptHook: string | null;
  durationS: number | null;
}

export interface AuditFlagCount {
  reason: string;
  count: number;
}

export interface PipelinePulse {
  window: "24h";
  signalsObserved: number;
  scripted: number;
  rendered: number;
  exported: number;
  liveRun: { stage: string; startedAt: string } | null;
  nextCronAt: string | null;
}

export interface FootageHealthEntry {
  game: string;
  segmentCount: number;
  avgUsedCount: number;
  lowInventory: boolean;
}

export interface QuotaSnapshot {
  groqRequestsToday: number;
  groqRequestsCeiling: number;
  youtubeUnitsToday: number;
  youtubeUnitsCeiling: number;
  actionsMinutesToday: number;
  actionsMinutesCeiling: number;
  kvStorageBytesUsed: number;
  kvStorageBytesCeiling: number;
}

export type LiveStatus = "live" | "degraded" | "down" | "unknown";

export interface TtsStatus {
  status: LiveStatus;
  lastCheckedAt: string;
  consecutiveFailures: number;
}

export interface KeyStatus {
  name: string;
  status: LiveStatus;
  fingerprint: string | null;
  last4: string | null;
  lastValidatedAt: string | null;
  lastRotatedAt: string | null;
  rotatable: boolean;
}

// Mirrors CONSOLE_SPEC.md §3's DirectiveSchema exactly.
export interface DirectiveCompiled {
  focusGames: string[];
  excludeTopics: string[];
  minOriginalityScore: number;
  maxUploadsPerDay: number;
  tone: "neutral" | "provocative" | "analytical" | null;
  editorialNote: string | null;
  voicePool: string[] | null;
  ttsRateRange: [string, string] | null;
  preferredSourceIds: string[];
  diversityMode: boolean;
}

export interface DirectiveSummary {
  version: number;
  createdAt: string;
  compiled: DirectiveCompiled;
}

export interface ConsoleSummary {
  pipelinePulse: PipelinePulse;
  readyForReview: ExportListItem[];
  reviewed: ExportListItem[];
  auditFlags: AuditFlagCount[];
  footageHealth: FootageHealthEntry[];
  quota: QuotaSnapshot;
  ttsStatus: TtsStatus;
  settings: DirectiveSummary;
  keys: KeyStatus[];
  mcpTokens: McpTokenSummary[];
  killswitch: { enabled: boolean };
}

export interface DryRunResult {
  wouldSkip: { signalId: string; title: string; reason: string }[];
  wouldPick: { signalId: string; title: string }[];
}

// Chat-agent console (Groq tool-calling over this same API surface —
// src/server/agent/**). Mirrors db/schema.ts's chat_sessions/chat_messages.
export interface ChatSessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

type ChatRole = "user" | "assistant" | "tool";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  toolName: string | null;
  toolArgsJson: string | null;
  toolResultJson: string | null;
  createdAt: string;
}

export interface AgentTurnResult {
  finalMessage: string;
  toolCallsMade: string[];
}

// Voice control (docs/DECISIONS.md's MCP-as-runtime-integration ADR):
// speech-to-text via Groq Whisper, tool calls dispatched through the MCP
// tool contract (src/server/mcp/server.ts) instead of directly, spoken
// replies handled client-side via the browser's own SpeechSynthesis API.
export interface VoiceTurnResult extends AgentTurnResult {
  sessionId: string;
}

// ---- the guided run's first three steps (plan v2 §7) ----
// Mirrors src/server/console/ideas.ts and run-plan.ts.

/** The topic set the console offers, in order. Kept in step with ideas.ts's TOPICS — the server rejects anything else with 422. */
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

// ---- the guided run (plan v2 §7 steps 4 and 5) ----
// Mirrors src/server/console/runs.ts and montage.ts exactly. A "run" is one
// `runs.trace_id`: the pipeline stamps every stage row of one invocation
// with it, and `scripts.trace_id` hangs that invocation's videos off it.

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
export type RunStatus = "not_triggered" | "queued" | "running" | "succeeded" | "failed";

export interface RunProgress {
  traceId: string;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  stages: RunStage[];
  videos: RunVideo[];
  note: string | null;
}

export interface RunSummary {
  traceId: string;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  videoCount: number;
}

/**
 * A preview clip for the waiting screen's montage — retrieved from Pexels
 * for one of the script's keywords. Preview only: the rendered video's
 * footage comes from the maintained library, and these clips never enter
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

export interface McpTokenSummary {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}
