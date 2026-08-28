# Mythos Engine — System Architecture

**Version:** 2.0 — pivot from MythosEngine (game-news publishing) to an autonomous YouTube Shorts pipeline. See `docs/DECISIONS.md` for the pivot rationale and the tradeoffs it accepted.
**Owner:** single operator (you). One human account, passkey-authenticated. No public sign-ups.
**Prime directive, carried over:** prefer a permanent, card-free free tier wherever one exists. It doesn't exist everywhere here — video generation has real costs the old text-only project didn't. Where it costs money, the cost is small, bounded, and stated plainly (§10), never hidden.

---

## 0. The stack, and what it costs

| Service | Permanent free? | Card-free? | Role |
|---|---|---|---|
| **Groq Cloud** (Llama 3.3 70B / 3.1 8B) | Yes — rate-limited, no credit system. ~30 req/min, ~6k tokens/min, ~14.4k req/day, enforced per organization | **Yes** | Script generation, critique, title/description/hashtag generation |
| **Microsoft Edge "Read Aloud" TTS**, via the `edge_tts` Python library (LGPL-3.0, `rany2/edge-tts`), invoked as a subprocess | Yes, but **not an official product** — no SLA, no ToS-sanctioned standalone use, can break without notice | **Yes** | Narration voice synthesis + word-level timestamps for captions |
| **Cloudflare Workers static assets** | Yes | **Yes** | Hosts the operator console and its API |
| **Cloudflare D1** | 5 GB, 5M row-reads/day | **Yes** | Pipeline state, scripts, footage/segment/render/upload records, audit log |
| **Cloudflare KV** | 1 GB, 100k reads/day, **1k writes/day** | **Yes** | Hot manifests, rate-limit counters, encrypted key vault |
| **Cloudflare Turnstile** | Yes | **Yes** | Bot protection on any public POST route |
| **GitHub Actions** | 2,000 min/mo private, unlimited public | **Yes** | Weekly footage refresh, daily render pipeline, scheduler. FFmpeg and yt-dlp both run here — Workers cannot execute native binaries or sustain multi-minute CPU jobs |
| **GitHub repo (orphan branch)** | Yes, subject to repo size sanity | **Yes** | The footage clip library. Not R2 — R2's free tier requires a card to activate at all; a rotating library of short trimmed clips fits comfortably in a git branch |
| **YouTube Data API v3** | Yes — 10,000 units/day default quota | **Yes** (Google account, no billing needed for this quota tier) | Read-only (`search.list`/`videos.list`/`channels.list`) for the weekly footage-source discovery search only. No upload/OAuth scope exists in this system — see §9 |
| **Reddit RSS/Atom syndication feeds, News RSS** | Yes | **Yes** | Zero-key trend sources — **not** Reddit's JSON/Data API, see §5.1 |
| **X (Twitter) API** | **No** — the free tier has no meaningful search access as of 2026 | N/A | Not in the default profile. Driver exists, disabled unless the operator has a paid tier |
| **YouTube Community tab** | No official API | **Yes**, but unofficial/fragile | Best-effort source, same fragility contract as `yt-captions` had in the old project |

**What this costs in practice:** effectively $0/month at 3 exports/day, with one caveat — Edge TTS is a free ride on an unofficial API, not a contractual guarantee. `config/providers.ts` keeps TTS behind the same driver interface as everything else specifically so a paid fallback (ElevenLabs, Groq TTS if it ships one) is a single env var away if Microsoft ever closes the endpoint off.

> Quotas and the Edge TTS endpoint's availability both change without warning. Treat every number here as **unverified at runtime**. `scripts/verify-quotas.mjs` re-checks the documented numbers against `src/config/quotas.ts` and warns on drift; it cannot detect an Edge TTS outage, only the pipeline's own retry/alerting can (§9).

---

## 1. Design principles

1. **Everything is a driver.** `llm.complete()`, `tts.synthesize()`, `downloader.fetch()`, `render.compose()`, `upload.publish()` are interfaces; providers are adapters selected by env, exactly as in the driver layer already built (`src/lib/drivers/**`). A provider swap is one new file and one env var.
2. **The repository is the database of record for the footage library.** Clips live on a git orphan branch with full provenance (source video id, channel, download timestamp, clip timestamp range) committed alongside them — not a mystery blob in someone's bucket.
3. **The pipeline is a state machine, not a prompt chain.** Every item — signal, script, render, upload — moves through explicit states with a persisted row. A crashed run resumes; it does not restart.
4. **Nothing uploads, ever — a human does.** The model *proposes* a script; a separate model pass *critiques* it; every render, regardless of score, reaches EXPORT (§9) packaged with the full audit trail behind it. No component in this system holds a YouTube upload credential. Autonomy stops at "produce a reviewable package," not at "publish" — the operator is the actual gate, and §9's AUDIT SUMMARY exists to make that five-second human judgment call well-informed instead of blind.
5. **Footage acquisition is isolated, rate-limited, and the only place third-party video is fetched.** The daily render pipeline never touches the network for footage — it only reads from the already-vetted library. This is both a policy-risk control and a reliability one: a render job that doesn't depend on a live scrape can't fail because YouTube changed its page layout at 1pm.
6. **Zero secrets in the browser.** Static console assets are public; the OAuth tokens, the vault key, and the Groq key run only in a Worker or in GitHub Actions.
7. **Cheap to be wrong.** Every stage is idempotent and keyed. A retry never double-uploads and never re-downloads footage already in the library.

---

## 2. Topology

```
   YOU ──passkey──► console (Cloudflare Worker)   ┐
                    ┌───────────────────────┐     │  writes settings/directives,
                    │  OPERATOR CONSOLE      │     │  reviews + downloads exports,
                    │  review queue, export  │     │  rotates keys, kills the run
                    │  downloads, key vault  │     │
                    └───────────┬───────────┘     │
                                │ POST /console/* (WebAuthn session cookie)
                                ▼
┌──────────────────────── CONSOLE WORKER (Cloudflare) ────────────────────────┐
│  auth · directive versioning · encrypted key vault · run/export queries      │
└───────┬───────────────────────────────┬─────────────────────────────────────┘
        │ reads/writes                  │ repository_dispatch (manual re-run)
        ▼                               │
   ┌──────────┐  ┌────────────┐         ▼
   │ D1 (SQL) │  │ KV         │   ┌───────────────────── SCHEDULER ───────────────────┐
   │ signals  │  │ enc. keys  │   │  GitHub Actions cron:                             │
   │ scripts  │  │ hot JSON   │   │   hourly  WATCH (trend ingestion)                 │
   │ segments │  │ ratelimits │   │   08/13/18 UTC  daily pipeline (script→export)    │
   │ renders  │  │ export blobs│  │   weekly  FOOTAGE REFRESH (§5.0)                  │
   │ exports  │  └────────────┘   └───────────┬───────────────────┬────────────────────┘
   │ runs     │                               │                   │
   │ audit    │                               ▼                   ▼
   │ directive│                   ┌─────── PIPELINE RUNNER (Node/TS, GH Actions) ──────┐
   └──────────┘                   │ 1 WATCH ▸ 2 SCORE ▸ 3 SCRIPT ▸ 4 CRITIC             │
        ▲                         │  ▸ 5 FOOTAGE SELECT ▸ 6 TTS+CAPTIONS ▸ 7 RENDER    │
        │ writes state            │  ▸ 8 AUDIT SUMMARY ▸ 9 EXPORT                      │
        └─────────────────────────┴──┬──────────────────┬──────────────────┬──────────┘
                                     ▼                   ▼                  ▼
                           ┌──────────────┐    ┌──────────────────┐  ┌──────────────┐
                           │  GROQ API    │    │  EDGE TTS         │  │ FFmpeg (local │
                           │ llama-3.3-70b│    │ (unofficial, free)│  │  to the runner)│
                           └──────────────┘    └───────────────────┘  └──────┬────────┘
                                                                              │ finished .mp4
                                                                              ▼
   ┌─────────────────┐  weekly           ┌──────────────────────┐   ┌───────────────────┐
   │ WALKTHROUGH      │ ─────────────►   │ FOOTAGE REFRESH job   │   │  EXPORT: KV blob   │
   │ CREATORS         │  yt-dlp download │  scene/motion scoring │   │  (mp4 + audit_json,│
   │ (long-form guides)│  (rate-limited)  │  → clip candidates    │   │  3-day TTL)        │
   └──────────────────┘                  └──────────┬────────────┘   └─────────┬──────────┘
                                                      ▼                          ▼
                                        ┌─────────────────────────┐   console review queue
                                        │ git orphan branch:       │   ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄▶
                                        │ assets-library (clips +  │   you, manually, via
                                        │ provenance metadata)     │   YouTube Studio
                                        └─────────────────────────┘
```

**Why GitHub Actions is the runner and not a Worker:** unchanged reasoning from MythosEngine, stronger here — FFmpeg rendering and yt-dlp downloads need a real filesystem, real CPU minutes, and the ability to execute a native binary, none of which Workers offer.

---

## 3. Provider abstraction

`config/providers.ts` is the only file that knows brand names — already built this way (see Phase 1 commit). Extended for this pivot:

```ts
export const LLM_DRIVERS      = ['groq', 'workers-ai', 'openai-compat'] as const;
export const TTS_DRIVERS      = ['edge-tts', 'elevenlabs', 'none'] as const;
export const DOWNLOAD_DRIVERS = ['yt-dlp'] as const;
export const RENDER_DRIVERS   = ['ffmpeg-local'] as const;
export const EXPORT_DRIVERS   = ['kv-blob'] as const;
export const CACHE_DRIVERS    = ['kv', 'memory'] as const;
```

**Default profile (`profiles/free.env`)** — the only profile that has to work:

```
LLM_DRIVER=groq
TTS_DRIVER=edge-tts
DOWNLOAD_DRIVER=yt-dlp
RENDER_DRIVER=ffmpeg-local
EXPORT_DRIVER=kv-blob
CACHE_DRIVER=kv
```

Every driver implements the same failure contract already established in `src/lib/drivers/types.ts`: `Result<T, DriverError>`, explicit timeout, bounded retries with jitter, quota fields where the provider exposes them. New interfaces this pivot needs:

```ts
export interface TtsDriver {
  synthesize(req: TtsRequest): Promise<Result<TtsResponse, DriverError>>;
}
export interface TtsResponse extends Quota {
  audio: Uint8Array<ArrayBuffer>;
  mimeType: string;
  wordTimings: { word: string; startMs: number; endMs: number }[];
}

export interface DownloadDriver {
  fetchVideo(req: { url: string; maxDurationS?: number }): Promise<Result<{ filePath: string; durationS: number }, DriverError>>;
}

export interface RenderDriver {
  compose(req: RenderRequest): Promise<Result<{ filePath: string; durationS: number }, DriverError>>;
}
export interface RenderRequest {
  footageClipPath: string;
  narrationAudioPath: string;
  captionCues: { text: string; startMs: number; endMs: number }[];
  outputPath: string;
}

export interface ExportDriver {
  store(req: ExportStoreRequest): Promise<Result<ExportStoreResponse, DriverError>>;
}
export interface ExportStoreRequest {
  key: string;
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: string;
  ttlSeconds: number; // 3 days by default — see §9
}
export interface ExportStoreResponse {
  key: string;
  sizeBytes: number;
}
```

No `UploadDriver` exists in this system. There is no automated publish path — see §9.

`DownloadDriver` and `RenderDriver` shell out to `yt-dlp` and `ffmpeg` respectively via `node:child_process` — neither is an npm package, so the "run `npm view`" rule doesn't apply, but the equivalent applies: pin `yt-dlp`'s version explicitly in the GitHub Actions workflow and verify its release checksum, the same supply-chain discipline for a non-npm binary dependency.

---

## 4. Data model (D1 / SQLite)

```sql
CREATE TABLE sources (                       -- trend-ingestion sources
  id            TEXT PRIMARY KEY,            -- 'reddit-r-gaming'
  kind          TEXT NOT NULL CHECK (kind IN ('reddit','rss','x','youtube_community')),
  url           TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_seen_at  TEXT
);

CREATE TABLE signals (                       -- one trending discussion observed
  id            TEXT PRIMARY KEY,            -- sha256(canonical_url)
  source_id     TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  canonical_url TEXT NOT NULL,
  title         TEXT NOT NULL,
  observed_at   TEXT NOT NULL,
  engagement_score REAL NOT NULL,            -- velocity/upvotes-normalized, drives SCORE stage
  simhash       TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN
                  ('observed','scored','scripted','critiqued','exported','rejected','failed')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  UNIQUE (source_id, canonical_url)
);

CREATE TABLE scripts (
  id            TEXT PRIMARY KEY,
  signal_id     TEXT NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
  hook          TEXT NOT NULL,               -- first 3 seconds
  body          TEXT NOT NULL,
  debate_question TEXT NOT NULL,
  word_count    INTEGER NOT NULL,
  originality_score REAL,                    -- critic-assigned, advisory — see §9
  status        TEXT NOT NULL CHECK (status IN ('draft','approved','rejected')),
  created_at    TEXT NOT NULL                -- drives "today's diversity" queries, §5.3/§5.6
);

CREATE TABLE footage_sources (                -- tracked long-form walkthrough channels
  id            TEXT PRIMARY KEY,
  channel_url   TEXT NOT NULL,
  game          TEXT NOT NULL,                -- 'minecraft' | 'subway-surfers' | 'gta-v' | ...
  license_note  TEXT NOT NULL                 -- operator's own recording, explicit reuse grant, etc.
);

CREATE TABLE footage_segments (                -- clips extracted by the weekly refresh job
  id            TEXT PRIMARY KEY,
  footage_source_id TEXT NOT NULL REFERENCES footage_sources(id) ON DELETE CASCADE,
  source_video_id TEXT NOT NULL,               -- YouTube video id of the long-form source
  clip_start_s  INTEGER NOT NULL,
  clip_end_s    INTEGER NOT NULL,
  motion_score  REAL NOT NULL,                 -- how the weekly job ranked this window
  library_path  TEXT NOT NULL,                 -- path on the assets-library branch
  used_count    INTEGER NOT NULL DEFAULT 0,
  last_used_at  TEXT,
  fetched_at    TEXT NOT NULL,
  CHECK (clip_end_s > clip_start_s)
);

CREATE TABLE renders (
  id            TEXT PRIMARY KEY,
  script_id     TEXT NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
  footage_segment_id TEXT NOT NULL REFERENCES footage_segments(id),
  tts_driver    TEXT NOT NULL,
  tts_voice     TEXT NOT NULL,                -- actual voice used, for the audit package + diversity queries
  duration_s    REAL,
  status        TEXT NOT NULL CHECK (status IN ('pending','rendered','failed')),
  audit_result  TEXT,                         -- JSON: AUDIT SUMMARY checks — advisory, never blocking, §9
  created_at    TEXT NOT NULL                 -- drives "today's diversity" queries, §5.5/§5.6
);

CREATE TABLE exports (
  id            TEXT PRIMARY KEY,
  render_id     TEXT NOT NULL REFERENCES renders(id),
  storage_key   TEXT NOT NULL,                -- KV key holding the mp4 bytes
  size_bytes    INTEGER NOT NULL,
  suggested_title TEXT NOT NULL,
  suggested_description TEXT NOT NULL,
  suggested_tags_json TEXT NOT NULL,
  contains_synthetic_media INTEGER NOT NULL DEFAULT 1, -- reminder for the operator's manual upload, not enforced
  audit_json    TEXT NOT NULL,                 -- script + critic output + footage provenance + TTS settings + audit_result
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,                 -- created_at + 3 days; KV TTL enforces the actual deletion
  status        TEXT NOT NULL CHECK (status IN
                  ('ready_for_review','downloaded','reviewed','discarded','expired'))
);

CREATE TABLE runs (                          -- observability, same shape as before
  id            TEXT PRIMARY KEY,
  started_at    TEXT NOT NULL, finished_at TEXT,
  stage         TEXT NOT NULL, status TEXT NOT NULL,
  tokens_in     INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0,
  error_class   TEXT, trace_id TEXT NOT NULL
);

CREATE TABLE audit_log (                     -- append-only; never UPDATE, never DELETE
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at            TEXT NOT NULL, actor TEXT NOT NULL,
  action        TEXT NOT NULL, subject TEXT NOT NULL, detail_json TEXT NOT NULL
);

CREATE TABLE directives (                    -- operator steering, versioned and revertible
  version       INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at    TEXT NOT NULL,
  raw_text      TEXT NOT NULL,
  compiled_json TEXT NOT NULL,               -- focus games, tone, banned topics, voice_pool,
                                              -- tts_rate_range, preferred_source_ids, diversity_mode
                                              -- (full schema: CONSOLE_SPEC.md §3)
  status        TEXT NOT NULL CHECK (status IN ('draft','active','superseded','reverted')),
  parent_version INTEGER REFERENCES directives(version)
);

CREATE TABLE credentials (                   -- WebAuthn passkeys. One human.
  credential_id TEXT PRIMARY KEY,
  public_key    BLOB NOT NULL,
  counter       INTEGER NOT NULL DEFAULT 0,
  transports    TEXT, created_at TEXT NOT NULL, last_used_at TEXT,
  label         TEXT NOT NULL
);

CREATE INDEX idx_signals_state    ON signals(state, observed_at DESC);
CREATE INDEX idx_segments_source  ON footage_segments(footage_source_id, used_count);
CREATE INDEX idx_renders_created  ON renders(created_at);   -- today's-diversity queries, §5.5/§5.6
CREATE INDEX idx_scripts_created  ON scripts(created_at);   -- today's-diversity queries, §5.3
CREATE UNIQUE INDEX idx_directive_active ON directives(status) WHERE status = 'active';
```

Same rationale as before: natural-key `UNIQUE` gives idempotency for free, `CHECK` makes illegal states unrepresentable, `audit_log` is append-only, `footage_segments.used_count`/`last_used_at` is what lets FOOTAGE SELECT (§5.5) rotate clips instead of reusing the same 15 seconds every day, and `renders.created_at`/`scripts.created_at` are what let the diversity logic (§5.3/§5.5/§5.6) know what's already run today without a separate tracking table.

---

## 5. Pipeline stages — contracts

### 0. FOOTAGE REFRESH (weekly cron — the only stage that touches third-party video)

- For each `footage_sources` row, `youtube.search` (Data API v3, 100 units/call) for that channel's long-form uploads, sorted by view count, filtered to duration ≥ 20 minutes (walkthrough/guide-length, not another Short).
- `yt-dlp` downloads the top candidate **only if its video id isn't already represented in `footage_segments`** — this is what makes "the most-watched walkthrough doesn't change often" cheap: most weeks, most channels produce zero new downloads.
- FFmpeg motion-scoring pass (frame-difference/`signalstats` over a sliding window) ranks candidate windows; the job clips the top-N into 15–30s segments, writes them to the `assets-library` orphan branch with commit metadata (source video id, channel, timestamp range), and inserts `footage_segments` rows.
- The full long-form download is deleted after clipping — the library holds only the trimmed, transformed segments, never the source video itself.
- **Known risk, stated plainly, not hidden:** downloading third-party video via `yt-dlp` is itself a YouTube ToS matter, separate from whether the resulting heavily-cropped-and-narrated clip qualifies as transformative use. Isolating this to one weekly, low-volume, fully-audited job is the mitigation this project chose — not a claim that the risk is zero. Revisit if a channel strike or takedown ever traces back to this stage.

### 1. WATCH (hourly cron)
- Subreddit RSS/Atom feeds (`reddit.com/r/<sub>/hot.rss`) via the generic RSS driver, real User-Agent, conditional GET where the server supports it (many don't send an ETag — the natural-key idempotent insert covers that case regardless). **Deliberately not Reddit's JSON/Data API**: blocked outright from at least some cloud IP ranges (confirmed by testing, not assumed) and licensed for non-commercial use only, which a monetized channel isn't — see docs/DECISIONS.md. News RSS, best-effort YouTube Community scraping (typed, fails safe like `yt-captions` did). X disabled in the free profile — no viable free API.
- Output: `signals` rows in `observed`.

### 2. SCORE
- Engagement-velocity scoring (upvote/comment growth rate, freshness decay), simhash dedupe against the trailing 7-day window.

### 3. SCRIPT (Groq, `openai/gpt-oss-120b` — `llama-3.3-70b-versatile` deprecated by Groq 2026-06-17)
- Structured JSON output only, `schemas/script.schema.json`. Fields: `hook` (≤3s read-aloud), `body`, `debate_question`, target 130–170 words total.
- The prompt receives the signal's title/summary and nothing else — no general "what you know about X," same hallucination-boundary discipline as MythosEngine's DRAFT stage.
- Which signal gets scripted next weights `directives.compiled_json.preferred_source_ids` (favor signals from those sources) and, when `diversity_mode` is on, actively spreads the day's 3 picks across different `sources.id` values rather than always taking the single highest-`engagement_score` signal — queries today's already-`scripted` signals (via `scripts.created_at`) to know what's already been picked today.

### 4. CRITIC (Groq, second pass, adversarial, doesn't see the drafting prompt)
- Scores `originality_score` 0–1: does this script take a genuine angle, or does it just recite the signal back with narrator filler?
- Flags anything resembling defamation of a named real person, medical/legal claims stated as fact, or content that reads as a verbatim repost of the source discussion.
- **Advisory only.** A low score or a policy flag does not stop the script from proceeding — it's carried forward into the AUDIT SUMMARY (§9) and surfaced prominently to the human reviewer. The operator, not this stage, decides what's too risky to upload.

### 5. FOOTAGE SELECT
- Picks a `footage_segments` row matching the directive's focus game(s), weighted away from recently-`last_used_at` segments. Increments `used_count`.
- When `diversity_mode` is on, the game itself is chosen first: exclude games already used by today's earlier renders (via `renders.created_at`) before calling `claimNextFootageSegment` — so a day's 3 videos default to 3 different games rather than 3 different clips of the same game.

### 6. TTS + CAPTION SYNC (Edge TTS)
- `src/lib/drivers/tts-edge.ts` shells out to `scripts/edge_tts_synth.py`, a thin wrapper around the `edge_tts` Python library requesting `WordBoundary` events explicitly (the bare `edge-tts` CLI hard-codes sentence-level boundaries and has no flag to change that — confirmed by testing it directly, not assumed). Returns audio bytes plus one `{word, startMs, endMs}` entry per word — no separate forced-alignment step needed.
- Word timings become `captionCues` for RENDER: rendered as bold, high-contrast text that fades word-group to word-group, matching the reference style in `docs/DECISIONS.md`'s pivot entry.
- Voice is picked from `directives.compiled_json.voice_pool` (or the full default curated pool in `src/config/voices.ts` when unset) — when `diversity_mode` is on, excluding voices already used by today's earlier renders. `rate`/`pitch` come from the directive's fixed value if set, otherwise randomized within `tts_rate_range` per render. The actual voice used is recorded on `renders.tts_voice`, both for the audit package and for tomorrow's diversity query.

### 7. RENDER (FFmpeg, local to the GitHub Actions runner)
- Crop/scale the footage segment to 1080×1920, filling ≥75% of frame height with gameplay (matches the "transformative" visual treatment the operator specified).
- Mute the source segment's original audio entirely; mix in the narration track.
- Burn in captions via an ASS subtitle file (word-timed fade, not a static SRT box) using FFmpeg's `ass` filter.
- Loop or trim the footage segment to the narration's exact duration.
- Headless export to MP4, `dist/render/<script_id>.mp4`, deleted only after a confirmed EXPORT write (§9).

### 8. AUDIT SUMMARY (deterministic — no model call). See §9 for full detail. Never blocks — informs the human reviewer.

### 9. EXPORT (Cloudflare KV, via `ExportDriver`)
- LLM-generated suggested title/description/hashtags, schema-validated — suggestions for the operator's manual upload, not submitted anywhere.
- Assembles `audit_json`: the script, the CRITIC verdict, footage provenance (segment id, source video id/channel, clip range), the TTS settings actually used (`renders.tts_voice`, rate, pitch), and the AUDIT SUMMARY result.
- `ExportDriver.store()` writes the rendered MP4 to KV with a 3-day TTL; inserts an `exports` row (`status = 'ready_for_review'`) pointing at the KV key. The console review queue (`CONSOLE_SPEC.md` §4) is where the operator downloads it and, eventually, uploads it to YouTube themselves.

---

## 6. Runtime API surface (Cloudflare Worker)

| Route | Purpose | Protection |
|---|---|---|
| `GET /healthz` | liveness | public |
| `GET /readyz` | D1 + KV reachability | public |
| `POST /auth/passkey/*` | WebAuthn register + authenticate | origin-bound, one allowed credential |
| `GET /console/*` | dashboard queries: runs, signals, scripts, renders, exports, directives | passkey session cookie, `__Host-` prefixed, HttpOnly, SameSite=Strict |
| `POST /console/directive` | new steering directive | session + CSRF + schema validation |
| `POST /console/keys/:name` | validate-then-swap a provider key | session + reauth (< 5 min old) |
| `POST /console/dispatch` | trigger a pipeline run ad hoc | session + rate limited to 10/hour |
| `POST /console/scripts/:id/approve` | approve a `pending_approval` script | session |
| `GET /console/exports` | list export packages, filterable by status | session |
| `GET /console/exports/:id/download` | stream the rendered MP4 from KV | session |
| `POST /console/exports/:id/mark-reviewed` | mark an export reviewed | session |
| `POST /console/exports/:id/discard` | discard an export early (frees the KV blob before TTL) | session |
| `GET /console/settings` | current pipeline settings (voice pool, rate, focus games, source weighting, diversity mode) | session |
| `PUT /console/settings` | update pipeline settings — compiles to a new directive | session + CSRF + schema validation |
| `POST /console/settings/reset-defaults` | compile + activate the canonical default directive (diverse games/sources/voices) | session |
| `POST /console/killswitch` | halt everything immediately | session + reauth (< 5 min old) |
| `GET /console/chat/sessions` / `POST /console/chat/sessions` | list / start a chat-agent session | session |
| `DELETE /console/chat/sessions/:id` | delete a chat session | session |
| `GET /console/chat/sessions/:id/messages` | full message history for one session | session |
| `POST /console/chat/sessions/:id/message` | one turn of the Groq tool-calling chat agent (`src/server/agent/**`) | session |
| `POST /console/mcp` | MCP JSON-RPC endpoint (`initialize`/`tools/list`/`tools/call`) over the same `AGENT_TOOLS` allowlist the chat agent uses — no key rotation or killswitch tool exists, by construction | session cookie **or** a bearer token verified against `mcp_tokens` (external MCP clients — Claude Desktop, Claude Code) |
| `GET /console/mcp-tokens` | list issued MCP access tokens (label, timestamps — never the token itself) | session |
| `POST /console/mcp-tokens` | issue a new MCP access token, shown once | session + reauth (< 5 min old) — credential-equivalent, same bar as key rotation |
| `DELETE /console/mcp-tokens/:id` | revoke an MCP access token | session |
| `POST /console/voice/transcribe` | speech-to-text via Groq Whisper for the voice control surface | session |
| `POST /console/voice/turn` | one voice turn — transcript in, tool calls dispatched through `POST /console/mcp`'s exact contract (actor `mcp` in `audit_log`, not `agent`) | session |

No `/api/ask` this time — there's no public content site to chat against. The console is the entire authenticated surface; nothing here causes an anonymous browser to trigger an LLM call, and there is no upload call anywhere in this system to trigger.

Full console design: **`CONSOLE_SPEC.md`**.

---

## 7. Secrets model

| Key | Where you get it | Scope |
|---|---|---|
| `GROQ_API_KEY` | console.groq.com | default |
| `YOUTUBE_API_KEY` | Google Cloud Console → Credentials → API Key, restricted to YouTube Data API v3 | read-only (`channels.list`/`search.list`/`videos.list`) — footage discovery only. There is no YouTube OAuth credential anywhere in this system; upload is manual, by the operator, in YouTube Studio |
| `CLOUDFLARE_API_TOKEN` | dash.cloudflare.com | Workers/KV/D1/Turnstile edit, no `Zone:Edit`. Also what the GitHub Actions render job uses to write export blobs to KV via the REST API (§9) |
| `VAULT_MASTER_KEY` / `SESSION_SIGNING_KEY` | `openssl rand -base64 32` | Worker secret only |
| `TWENTYFIRST_API_KEY` | 21st.dev | dev machine only, never CI/Workers |

Edge TTS needs no key at all — that's the entire appeal and the entire risk (§0).

**Where each key lives** — unchanged shape from MythosEngine: developer machine `.env.local` (gitignored), GitHub Actions Repository Secrets, `wrangler secret put` for the Worker, the console's own KV vault (AES-GCM under `VAULT_MASTER_KEY`) for rotatable provider keys. `CLOUDFLARE_API_TOKEN` stays outside the vault, same reasoning as before: a console that can rewrite its own infrastructure credentials is a privilege-escalation path.

---

## 8. Console frontend

Astro island(s) mounted only on `/console/*`, same `tokens.css` token discipline as before — the wet-slate palette's ground tone moved to true black (`--ink: #000000`, `--slate: #0a0a0c`) on 2026-08-28 specifically so WebGL/canvas elements (the Liquid Metal shader, the Siri Wave) read as native to the page rather than sitting in a visibly separate box; see `docs/DECISIONS.md`. One `@astrojs/react` island (`PromptInputBox.tsx`, `/console/chat` only) is the sole framework exception — everything else, including the radial nav's full-screen/compact states, is plain Astro + vanilla TS. There is no public marketing hero to build here; skip straight to the dashboard. Full spec in `CONSOLE_SPEC.md`.

---

## 9. AUDIT SUMMARY — informing the human, not replacing them

YouTube's inauthentic-content policy (renamed from "repetitious content," July 2025) explicitly targets mass-produced, templated, reused-visual videos with a three-strike system: warning → 90-day Partner Program suspension → permanent removal. Naive automation — the exact "narrate a script over recycled B-roll on a timer" pattern this project builds — is precisely what it's aimed at. Earlier versions of this project addressed that risk with a deterministic POLICY GATE that blocked automated upload outright. That's no longer the shape of the risk: **nothing in this system uploads automatically, ever** — the operator reviews and uploads every video by hand, in YouTube Studio, under their own judgment. The operator is the actual gate now.

AUDIT SUMMARY exists so that judgment call is fast and well-informed instead of blind. It runs the same checks the old GATE did, computed deterministically (no model call) on every render, stored on `renders.audit_result` and folded into the export's `audit_json` (§5.9) — but it **never blocks progression**. Every render reaches EXPORT regardless of its result; a failing check is a prominent flag in the review package, not a rejection.

Checks:

- JSON Schema validation on the script and the suggested upload metadata (Zod).
- `originality_score` (from the CRITIC stage) vs. the active directive's `min_originality_score` — reported as pass/fail, not enforced.
- Word count, hook length, and debate-question presence within bounds.
- The footage segment came from `footage_segments` (library-only, §1 NEVER of `CLAUDE.md`) — this one *is* structurally enforced earlier, at FOOTAGE SELECT/RENDER, not here; AUDIT SUMMARY just echoes the provenance for the reviewer.
- Rotation health: how recently `footage_segment_id`/`renders.tts_voice` were last used (variety signal, not a rule).
- Similarity to the last 100 scripts < 0.85 (self-repetition — the failure mode that reads as "templated" to YouTube's classifier — flagged, not blocked).
- A reminder that the synthetic-media disclosure (`status.containsSyntheticMedia`, confirmed against Google's current Data API v3 docs) should be set when the operator uploads manually.
- Caption/audio duration match within tolerance (flagged if a render's captions run past the narration audio).

Every signal computed here is visible in the console's review queue (`CONSOLE_SPEC.md` §4) before the operator downloads or discards an export.

---

## 10. Quota & cost budget

Assume 3 exports/day.

| Resource | Per-day consumption | Free ceiling | Headroom |
|---|---|---|---|
| Groq requests | ~24 score-passes + 3 scripts + 3 critics + 3 metadata-gens ≈ 33 | ~14,400/day | huge |
| YouTube Data API units | weekly footage-source search only ≈ 100–500/day amortized | 10,000/day | huge — no upload calls exist anymore, this dropped by two orders of magnitude from the earlier upload-based design |
| GitHub Actions minutes | hourly WATCH × 24 (~1 min each) + 3 render jobs × ~5 min (FFmpeg is the expensive part) + weekly footage job (~15 min) ≈ ~40 min/day | 2,000 min/mo private | fine — public repo removes the ceiling entirely |
| KV writes | batch manifest + rate-limit counters + 3 export blobs ≈ well under 50 | 1,000/day | fine |
| KV storage | 3 exports/day × 3-day TTL ≈ ~9 exports resident at once × (MP4 size, TBD — see §3's `ExportDriver` note) | 1GB total | needs the real render-size check before this is a settled "fine," not before |
| Edge TTS | 3 × ~150 words ≈ 450 words/day | no formal quota — it's not a real product | **the actual risk isn't quota, it's the endpoint disappearing.** Alert loudly on TTS driver failure, don't silently fall back to a paid provider without telling the operator |

The two real constraints, updated from before: **KV's per-value and total storage caps** (settled once Phase 6 measures a real rendered file against them, per the open item in §3) and **Edge TTS's unofficial status** (this is a reliability risk, not a cost one — budget for it with retries and a loud alert, not with money). YouTube API quota is no longer a meaningful constraint now that nothing here uploads.

---

## 11. Failure modes this design closes

| Domain | Closed by |
|---|---|
| Platform policy | no automated publish path exists at all — the operator manually reviews and uploads every video; AUDIT SUMMARY (§9) still surfaces every signal the old GATE checked, so that review is fast, not blind |
| Copyright/ToS exposure | footage acquisition isolated to one weekly, low-volume, fully-audited job; daily render never touches the network for footage |
| Architecture | driver interfaces; repo-as-source-of-truth for the footage library; one shared schema between pipeline and console |
| Security | no client keys; no YouTube OAuth credential anywhere in the system (§7) — only a read-only API key for footage search; Turnstile + rate limit on any public route; gitleaks in history + bundle scan |
| Data integrity | natural-key UNIQUE = idempotency; CHECK constraints; state machine with single-step transitions |
| Reliability | `Result<>` instead of exceptions; per-stage timeouts; backoff + jitter; a `failed` state with `attempts` as the DLQ |
| Observability | `runs` + `audit_log`; alert on Edge TTS failure rate, KV export-write failures, or 3 consecutive stage failures |
| Maintainability | strict TS, no `any`, no `@ts-ignore`; `knip` in CI |
| Ownership | `docs/DECISIONS.md` ADR log, including this pivot itself |
