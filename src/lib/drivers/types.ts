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
  /**
   * The provider's raw 4xx body, untruncated (bounded — see `fetchWithRetry`).
   *
   * `message` already carries the first 400 characters of it, which is the
   * right amount for a log line and the wrong amount for a body a caller
   * has to *parse*. Groq's `tool_use_failed` is the case that forced this:
   * the whole model generation the request rejected travels in
   * `error.failed_generation`, several kilobytes in, and recovering it from
   * a truncated sentence is not possible. Present only on 4xx, absent
   * everywhere else.
   */
  responseBody?: string;
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
  /**
   * Opaque provider transcript state, echoed back verbatim and never read
   * by the caller. Copy it from the `LlmResponse` that produced this turn.
   *
   * This exists because Gemini's Interactions API is **not** statelessly
   * replayable the way an OpenAI-shaped `messages` array is. Its responses
   * interleave `thought` steps carrying a signed `signature`, and a
   * follow-up request that reconstructs the turn from `content` +
   * `toolCalls` alone — which is all this interface carries otherwise — is
   * rejected outright with `invalid_request`. Measured against the live API
   * on 2026-09-01: echoing the response's `steps` verbatim succeeds,
   * dropping the `thought` step fails.
   *
   * Deleted with the Gemini reasoning split on 2026-09-01 and restored on
   * 2026-09-02, when RESEARCH's first attempt went back to Gemini by
   * operator direction (src/lib/rag/research-provider.ts). Nothing else
   * needs it: RESEARCH is the only tool loop that runs on Gemini.
   *
   * The honest shape is an opaque box. A tool loop pushes whatever it
   * received back onto the next request without interpreting it, `groq.ts`
   * ignores the field entirely, and neither driver has to know the other
   * exists. The alternative — teaching every tool loop to speak Gemini's
   * step vocabulary — would put a provider's wire format in
   * src/lib/rag/research.ts, which is exactly the leak the driver layer is
   * here to prevent.
   */
  providerSteps?: unknown;
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
  /**
   * How much of the completion budget the model may spend thinking before
   * it emits anything, on the providers that expose the knob.
   *
   * Undefined means the model's own default, which is what every stage that
   * reasons wants. `"none"` is for a stage that is mechanical rather than
   * argumentative and is metered on **output** tokens — EDIT, where the
   * qwen3 models' 1,000-output-tokens-per-minute meter makes a hidden
   * reasoning trace both the thing that truncates the answer and the thing
   * that empties the minute's allowance (`src/lib/pipeline/edit.ts`).
   *
   * A driver whose provider has no such parameter ignores it, which is the
   * honest behaviour: it is a hint about spend, never about correctness.
   */
  reasoningEffort?: "none" | "low" | "medium" | "high";
}

/**
 * `LlmResponse.finishReason` for a turn the *provider* rejected and this
 * project put back together — today only Groq's `tool_use_failed` 400, whose
 * `failed_generation` carries the model's own words (see
 * `recoverFailedGeneration` in groq.ts).
 *
 * It is a real answer, so it is returned as one, but it is an answer that
 * did not reach the provider's tool channel: whatever the model was trying
 * to call, it did not call. A tool loop has to be able to tell that apart
 * from a model that chose to stop, which is the difference between nudging
 * it and giving up on the clip.
 */
export const TOOL_USE_FAILED_RECOVERED = "tool_use_failed_recovered";

export interface LlmResponse extends Quota {
  content: string;
  finishReason: string;
  toolCalls?: ToolCall[];
  /**
   * This turn's opaque provider state. Push it onto the assistant message
   * that continues the conversation; see `LlmMessage.providerSteps`.
   * Undefined from any driver that does not need one, which is every
   * driver but Gemini.
   */
  providerSteps?: unknown;
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
 * One action of the host, in the order it plays.
 *
 * The host is a *track*, not a single looping asset: the pack ships 19
 * separate actions and `src/lib/pipeline/character-timeline.ts` lays them
 * end to end deterministically — hello, then every other action in manifest
 * order on a loop, then goodbye.
 *
 * **There is no chroma key anywhere in this system.** The original host was
 * a GIF on a flat `#e5505c` field behind a face whose red channel matched
 * it, which left a tolerance window so narrow that 0.14 ate her cheeks and
 * 0.20 destroyed the face. The pack's MOVs carry a real 8-bit alpha
 * channel, so the key, its similarity, its blend and that whole class of bug
 * are gone. The hand-counted frame holds that stretched that GIF are gone
 * with it: holding an action now means playing the next one.
 */
export interface CharacterClip {
  /** Path to the action clip. An alpha MOV from the pack's `mov/` directory. */
  filePath: string;
  /** The manifest action id (e.g. `talk_emphatic_loop`) — recorded in the audit package. */
  actionId: string;
  /**
   * Seconds of this action that play.
   *
   * Equal to `naturalDurationS` for every clip but one: the single partial
   * action that lands the goodbye wave on the end of the video. **Never
   * greater** — the track is assembled with ffmpeg's concat demuxer, which
   * can cut an entry short but cannot loop one, so a request for more than
   * the file holds is not a thing the encoder can honour.
   */
  durationS: number;
  /** The clip's own length, so a caller can tell a trimmed action from a whole one without re-reading the manifest. */
  naturalDurationS: number;
}

/**
 * The host's track and where it sits in the frame.
 *
 * Composited by its own ffmpeg pass over an already-finished video
 * (`src/lib/drivers/character-overlay-ffmpeg.ts`), not by the render — see
 * that file for why the two are separate.
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
 * One pass of the character overlay: a finished video in, the same video
 * with the host on top out.
 */
export interface CharacterOverlayRequest {
  /** The finished video — footage, narration and burned-in captions, no host. */
  videoPath: string;
  overlay: CharacterOverlay;
  outputPath: string;
  /**
   * How long the finished video is, from `RenderResponse.durationS`.
   *
   * Passed as an explicit `-t` because the host track is built to run *past*
   * the end rather than stop short of it
   * (src/lib/pipeline/character-timeline.ts), so something has to say where
   * the video ends. That something is the video's own measured length.
   */
  durationS: number;
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
   * Explicit rather than left to `-shortest`, which does not settle it once
   * the footage track has a definite end — the first montage ever composited
   * came out 13.5s over a 12.0s narration. A single looped clip never hit
   * this, because nothing in that graph ever ended.
   */
  outputDurationS?: number;
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
