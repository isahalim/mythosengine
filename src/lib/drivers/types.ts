import type { Result } from "../result.ts";

/**
 * Every driver's failure contract (ARCHITECTURE.md §3): typed errors, no
 * thrown exceptions across a driver boundary.
 */
export interface DriverError {
  kind:
    | "timeout"
    | "rate_limited"
    | "invalid_response"
    | "network"
    | "provider_error"
    | "not_implemented"
    // A deliberate refusal, not a technical failure — e.g. a candidate video
    // exceeding maxDurationS. Never retryable; retrying can't fix a policy call.
    | "policy_violation";
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
}

/** Present on every driver response so the runner can back off before 429. */
export interface Quota {
  quotaRemaining: number | null;
  tokensUsed: number | null;
}

/** A single tool invocation the model asked for, or (on a "tool" message) the answer to one. */
export interface ToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Set on an "assistant" message that invoked one or more tools. */
  toolCalls?: ToolCall[];
  /** Set on a "tool" message — which call (by id) this content answers. */
  toolCallId?: string;
}

/** JSON-Schema-described function a tool-calling model may choose to invoke (src/server/agent/tools.ts). */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: unknown;
}

export interface LlmRequest {
  model: string;
  messages: LlmMessage[];
  jsonSchema?: unknown;
  maxTokens?: number;
  temperature?: number;
  tools?: ToolDefinition[];
  toolChoice?: "auto" | "none";
}

export interface LlmResponse extends Quota {
  content: string;
  finishReason: string;
  toolCalls?: ToolCall[];
}

export interface LlmDriver {
  complete(req: LlmRequest): Promise<Result<LlmResponse, DriverError>>;
}

export interface AsrRequest {
  /** Raw audio bytes, or a YouTube video id for caption-based drivers. */
  source: { kind: "audio"; bytes: Uint8Array<ArrayBuffer>; mimeType: string } | { kind: "youtube"; videoId: string };
}

export interface AsrSegment {
  start: number;
  end: number;
  text: string;
}

export interface AsrResponse extends Quota {
  transcript: string;
  segments: AsrSegment[];
}

export interface AsrDriver {
  transcribe(req: AsrRequest): Promise<Result<AsrResponse, DriverError>>;
}

export interface TtsRequest {
  text: string;
  voice: string;
  rate?: string; // e.g. "+0%"
  volume?: string; // e.g. "+0%"
  pitch?: string; // e.g. "+0Hz"
}

export interface TtsWordTiming {
  word: string;
  startMs: number;
  endMs: number;
}

export interface TtsResponse extends Quota {
  audio: Uint8Array<ArrayBuffer>;
  mimeType: string;
  wordTimings: TtsWordTiming[];
}

export interface TtsDriver {
  synthesize(req: TtsRequest): Promise<Result<TtsResponse, DriverError>>;
}

export interface DownloadRequest {
  url: string;
  /** Refuse (policy_violation) rather than download anything longer than this. */
  maxDurationS?: number;
}

export interface DownloadResponse {
  filePath: string;
  durationS: number;
  sourceVideoId: string;
}

export interface DownloadDriver {
  fetchVideo(req: DownloadRequest): Promise<Result<DownloadResponse, DriverError>>;
}

export interface CaptionCue {
  text: string;
  startMs: number;
  endMs: number;
}

export interface RenderRequest {
  footageClipPath: string;
  narrationAudioPath: string;
  captionCues: CaptionCue[];
  outputPath: string;
}

export interface RenderResponse {
  filePath: string;
  durationS: number;
}

export interface RenderDriver {
  compose(req: RenderRequest): Promise<Result<RenderResponse, DriverError>>;
}

/**
 * No UploadDriver exists in this system, by design — there is no automated
 * publish path (ARCHITECTURE.md §9, docs/DECISIONS.md manual-review pivot).
 * ExportDriver packages a finished render into storage the operator can
 * download and review; nothing here ever calls a YouTube upload endpoint.
 */
export interface ExportStoreRequest {
  key: string;
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: string;
  /** 3 days by default — ARCHITECTURE.md §9. */
  ttlSeconds: number;
}

export interface ExportStoreResponse {
  key: string;
  sizeBytes: number;
}

export interface ExportDriver {
  store(req: ExportStoreRequest): Promise<Result<ExportStoreResponse, DriverError>>;
}

export interface ChannelTopVideoRequest {
  /** A channel handle, without the leading @ (e.g. "HollowPoiint"). */
  channelHandle: string;
  /** Only consider videos at least this long — filters out another Short. */
  minDurationS: number;
}

export interface ChannelTopVideoResponse {
  videoId: string;
  title: string;
  durationS: number;
  viewCount: number;
}

export interface YoutubeSearchDriver {
  /** Ranked by view count, highest first; empty array (not an error) if no video meets minDurationS. Callers should try candidates in order and fall through on a per-video failure (age-restricted, removed, transiently unavailable — all observed live, 2026-08-29) rather than failing the whole channel on the first pick. */
  findTopLongFormVideos(req: ChannelTopVideoRequest): Promise<Result<ChannelTopVideoResponse[], DriverError>>;
}

export interface EmbedRequest {
  texts: string[];
}

export interface EmbedResponse extends Quota {
  vectors: number[][];
  dimensions: number;
}

export interface EmbedDriver {
  embed(req: EmbedRequest): Promise<Result<EmbedResponse, DriverError>>;
}

export interface VectorRecord {
  id: string;
  vector: number[];
  metadata: Record<string, string>;
}

export interface VectorQuery {
  vector: number[];
  topK: number;
}

export interface VectorMatch {
  id: string;
  score: number;
  metadata: Record<string, string>;
}

export interface VectorDriver {
  upsert(records: VectorRecord[]): Promise<Result<{ count: number }, DriverError>>;
  query(query: VectorQuery): Promise<Result<VectorMatch[], DriverError>>;
}

export interface CacheDriver {
  get(key: string): Promise<Result<string | null, DriverError>>;
  put(key: string, value: string, ttlSeconds?: number): Promise<Result<void, DriverError>>;
}
