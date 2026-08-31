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
  /** Ask for per-word timings as well as segments. ALIGN needs them; a plain transcription does not. */
  wordTimestamps?: boolean;
  /** Raw audio bytes, or a YouTube video id for caption-based drivers. */
  source: { kind: "audio"; bytes: Uint8Array<ArrayBuffer>; mimeType: string } | { kind: "youtube"; videoId: string };
}

/**
 * A single word with its timing, from Whisper's word-level granularity.
 *
 * This is what makes Gemini TTS usable at all (plan v2 §4's ALIGN stage):
 * Gemini returns audio and no timings, and the word-level captions this
 * system is built around came entirely from Edge TTS's `WordBoundary`
 * events. Force-aligning the audio is how they are recovered.
 */
export interface AsrWord {
  word: string;
  start: number;
  end: number;
}

export interface AsrSegment {
  start: number;
  end: number;
  text: string;
}

export interface AsrResponse extends Quota {
  /**
   * Word-level timings, present only when the request asked for them
   * (`wordTimestamps`) and the provider returned them. Empty otherwise — a
   * transcript-only call has no reason to pay for them.
   */
  words: AsrWord[];
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
  /**
   * Natural-language delivery direction, e.g. "Read this as someone
   * thinking out loud, catching herself mid-thought." Gemini TTS accepts one
   * and it is the entire reason that driver exists (plan v2 §4).
   *
   * **Edge TTS cannot honour this**, and `EdgeTtsDriver` says so out loud
   * rather than ignoring the field: `rate`/`volume`/`pitch` are the only
   * delivery controls that endpoint has. A caller that sets this and lands
   * on the Edge path gets flat delivery, and the audit package records which
   * driver actually spoke (ARCHITECTURE.md §9).
   */
  styleDirection?: string;
}

export interface TtsWordTiming {
  word: string;
  startMs: number;
  endMs: number;
}

export interface TtsResponse extends Quota {
  audio: Uint8Array<ArrayBuffer>;
  mimeType: string;
  /**
   * Per-word timings, or an **empty array** when the driver cannot produce
   * them — which is the single most important technical fact in plan v2.
   *
   * Edge TTS emits them natively via `WordBoundary`. Gemini TTS returns
   * audio and nothing else, so its driver returns `[]` and the caller must
   * recover timings by force-aligning the audio (ALIGN, src/lib/pipeline/
   * align.ts). Empty here therefore means "ask ALIGN", never "this audio has
   * no words" — a caller that treats it as the latter silently deletes the
   * word-level captions this system is built around.
   */
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
  /**
   * The cue's individual words with their own timings, when the caller has
   * them — which enables per-word highlighting (plan v2 §1: "word-level +
   * keyword highlighting").
   *
   * Optional because the cue is still perfectly renderable without it: the
   * whole group appears for its whole span, which is what v1 did. A caller
   * that has word timings and omits these gets the v1 look, not a broken
   * one.
   */
  words?: { text: string; startMs: number; endMs: number }[];
  /**
   * Normalized words in this cue that carry the meaning — rendered in the
   * accent colour for the cue's whole life, not just while spoken.
   */
  keywords?: string[];
}

/**
 * A looping character composited over the footage, chroma-keyed.
 *
 * The key values are measured, not guessed (plan v2 §2): the asset's
 * background is a flat `#e5505c` and her face is `#e48080` — the same red
 * channel, 48/36 apart in green and blue. `similarity` 0.10 removes the
 * background with her face, blush, glasses and hair intact; **0.14 begins
 * eating her face and 0.20 destroys it**, so 0.10 is the ceiling rather than
 * a starting point.
 */
export interface CharacterOverlay {
  /** Path to the character loop (a GIF or video file ffmpeg can read). */
  filePath: string;
  /** Key colour in ffmpeg's `0xRRGGBB` form. */
  keyColor: string;
  /** colorkey similarity. Treat 0.10 as a ceiling for the measured asset. */
  similarity: number;
  blend: number;
  /** Fraction of the output height the character occupies. */
  heightRatio: number;
}

export interface RenderRequest {
  footageClipPath: string;
  narrationAudioPath: string;
  captionCues: CaptionCue[];
  outputPath: string;
  /** Absent means no character — the v1 look, and what a render falls back to when the asset is missing. */
  characterOverlay?: CharacterOverlay;
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
  /** The footage source's game (footage_sources.game) — folded into the agentic search query alongside channelHandle. Optional so a caller without this context still gets a valid, if less targeted, search. */
  game?: string;
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
