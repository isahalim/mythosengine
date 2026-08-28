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
