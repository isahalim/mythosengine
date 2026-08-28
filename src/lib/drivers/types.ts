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

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmRequest {
  model: string;
  messages: LlmMessage[];
  jsonSchema?: unknown;
  maxTokens?: number;
  temperature?: number;
}

export interface LlmResponse extends Quota {
  content: string;
  finishReason: string;
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

export interface UploadRequest {
  filePath: string;
  title: string;
  description: string;
  tags: string[];
  /** youtube.com/t/terms video category id. "20" = Gaming. */
  categoryId?: string;
  privacyStatus?: "public" | "unlisted" | "private";
  /**
   * Always true here — this pipeline's videos always have AI narration.
   * Maps to the YouTube Data API v3 `status.containsSyntheticMedia` field
   * (confirmed against Google's docs 2026-08-27, not guessed).
   */
  containsSyntheticMedia: true;
}

export interface UploadResponse {
  videoId: string;
  url: string;
}

export interface UploadDriver {
  publish(req: UploadRequest): Promise<Result<UploadResponse, DriverError>>;
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
