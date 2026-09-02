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
  /**
   * Which model actually answered, when that can differ from `req.model`.
   * Every driver here answers on the model it was asked for, so this is
   * normally undefined and callers fall back to `req.model`; it stays in
   * the interface because the audit package's contract is to record the
   * model that really spoke, not the one that was requested.
   */
  modelUsed?: string;
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
/**
 * One hold in the character's loop — a beat where she waits on screen
 * instead of running straight through to the end.
 *
 * The loop is 5.6s of continuous motion, which reads as restless under a
 * two-minute narration. Holds stretch it by parking her on chosen frames,
 * so she still moves but arrives at the end of the cycle far less often.
 *
 * `frames: 1` freezes on `atFrame`. `frames: 2` or more cycles through that
 * many consecutive frames for the whole hold, which keeps a little life in
 * her rather than stopping her dead.
 */
/**
 * One action of the host, on screen for a span of the video.
 *
 * The host is a *track* now, not a single looping asset (operator
 * direction, 2026-09-01). The robot pack ships 19 separate actions and PLAN
 * chooses one per scene, so the host is assembled the same way the footage
 * is: an ordered list of clips, each held for as long as its scene lasts,
 * concatenated into one stream and composited once.
 *
 * This replaced a single GIF stretched by hand-counted frame holds. Those
 * holds existed only because one 5.6-second loop had to cover a
 * two-minute narration without reading as a fidget, and they were tied to
 * frame numbers counted off that one asset — replacing the asset meant
 * recounting them. Cutting between real actions solves the same problem
 * with the pack's own material and no magic numbers.
 */
export interface CharacterClip {
  /** Path to the action clip. An alpha MOV from the pack's `mov/` directory. */
  filePath: string;
  /** The manifest action id (e.g. `talk_emphatic_loop`) — recorded in the audit package. */
  actionId: string;
  /**
   * Seconds this action is on screen. The clip is looped to fill the span
   * if it is shorter and cut if it is longer; every clip in the pack is a
   * seamless loop, so holding one is invisible.
   */
  durationS: number;
}

/**
 * The host's track for one render.
 *
 * **There is no chroma key any more, and that is the point.** The old asset
 * was a flat `#e5505c` fill behind a face whose red channel matched it
 * exactly, which left a tolerance window so narrow that 0.14 ate her cheeks
 * and 0.20 destroyed the face. The robot pack's MOVs carry a real 8-bit
 * alpha channel, so the key, its similarity, its blend, and the whole class
 * of "raising this number takes her face with it" bug are simply gone.
 */
export interface CharacterOverlay {
  /** The ordered action track. Never empty — a render with no actions composites no host at all. */
  clips: CharacterClip[];
  /** Fraction of the output height the host occupies. */
  heightRatio: number;
  /**
   * How far the host floats above the bottom edge, as a fraction of output
   * height. The previous host was drawn cropped by that edge and sat flush
   * on it; this pack's character floats clear of all four edges, so a
   * flush-bottom anchor would plant a floating robot on the floor.
   */
  bottomMarginRatio: number;
}

/**
 * One clip in a render's footage track.
 *
 * `durationS` is how long this clip is on screen in the finished video, not
 * how long the file is: a clip shorter than its slot is looped to fill it
 * and a longer one is cut. Omitted only in the single-clip case, where the
 * clip loops for the whole narration — which is what a gameplay render has
 * always done, expressed rather than implied.
 */
export interface FootageClip {
  filePath: string;
  durationS?: number;
}

export interface RenderRequest {
  /**
   * The footage track, in order. One clip is the gameplay path; several are
   * a stock montage cut to the script's beats (src/lib/footage/stock.ts).
   */
  footageClips: FootageClip[];
  narrationAudioPath: string;
  captionCues: CaptionCue[];
  outputPath: string;
  /**
   * How long the finished video should be — the narration's measured
   * length.
   *
   * Explicit rather than left to `-shortest`, because `-shortest` alone does
   * not settle it once the footage track has a definite end: the character
   * overlay is composited with `shortest=0` (so a looping host can never
   * truncate the video) and keeps the video stream alive past the audio,
   * which produced a 13.5s render over a 12.0s narration the first time a
   * montage was composited. A single looped clip never hit this because
   * nothing in that graph ever ended.
   */
  outputDurationS?: number;
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
  /** 2 days by default — ARCHITECTURE.md §9, shortened from 3 by operator direction 2026-09-01. */
  ttlSeconds: number;
}

export interface ExportStoreResponse {
  key: string;
  sizeBytes: number;
}

export interface ExportDriver {
  /**
   * The storage key this driver would use for a render.
   *
   * On the driver rather than on the caller because the key format is what
   * identifies the backend: `src/server/console/exports.ts` reads a
   * download's store off the key shape (`exports/<id>.mp4` is an R2 object,
   * `export:<id>.mp4` a legacy KV value), so a driver that chose a shape it
   * does not actually write to would send the console looking in the wrong
   * place.
   */
  keyFor(renderId: string): string;
  store(req: ExportStoreRequest): Promise<Result<ExportStoreResponse, DriverError>>;
  /**
   * Frees a blob whose review window has closed (`db/exports-reap.ts`).
   *
   * On the driver because R2 — unlike KV — has no per-object TTL, so
   * something has to actually delete the bytes, and the store that wrote
   * them is the only thing that knows how to reach them.
   */
  remove(key: string): Promise<Result<void, DriverError>>;
}

export interface ChannelTopVideoRequest {
  /**
   * A channel handle, without the leading @ (e.g. "HollowPoiint").
   *
   * Optional since 2026-09-01: the sourcing agent searches YouTube openly,
   * by `query` below, rather than within one maintained channel. The weekly
   * FOOTAGE REFRESH still passes a handle, and that path is unchanged.
   */
  channelHandle?: string;
  /** Only consider videos at least this long — filters out another Short. */
  minDurationS: number;
  /** The footage source's game (footage_sources.game) — folded into the search query alongside channelHandle. Optional so a caller without this context still gets a valid, if less targeted, search. */
  game?: string;
  /**
   * A free-form search query, used verbatim when present.
   *
   * Operator direction 2026-09-01 opened footage sourcing beyond the
   * maintained channel: a shot plan asks for "courtroom gavel" or "GTA 6
   * walkthrough gameplay" and there is no channel in that question. When
   * this is set it wins outright — `channelHandle` and `game` are not
   * folded in, because a query the planner wrote is already the query.
   */
  query?: string;
}

export interface ChannelTopVideoResponse {
  videoId: string;
  title: string;
  durationS: number;
  viewCount: number;
}

/** Everything a search needs to be reproducible in an audit: what was asked, and what came back. */
export interface SourcedVideo extends ChannelTopVideoResponse {
  /** The query that found it — recorded per clip, so "why is this shot here" is answerable. */
  query: string;
  url: string;
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
