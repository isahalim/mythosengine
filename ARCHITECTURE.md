# Mythos Engine — System Architecture

**Version:** 2.0 — pivot from MythosEngine (game-news publishing) to an autonomous YouTube Shorts pipeline. Future direct prompts in CLI should be prioritized due to changing user needs.
**Owner:** single operator (you). One human account, passkey-authenticated. No public sign-ups.
**Prime directive, carried over:** prefer a permanent, card-free free tier wherever one exists. It doesn't exist everywhere here — video generation has real costs the old text-only project didn't. Where it costs money, the cost is small, bounded, and stated plainly (§10), never hidden.

---

## 0. The stack, and what it costs

| Service | Permanent free? | Card-free? | Role |
|---|---|---|---|
| **Google Gemini**, text models | Yes — **5 requests/minute and 250K tokens/day _per model_** (read off the operator's own AI Studio rate-limit page, 2026-09-01) | **Yes — RESEARCH's first attempt only, since 2026-09-02** | **One stage, four requests.** Gemini drove RESEARCH, reranking, SCRIPT, PLAN and EDIT for a few hours on 2026-09-01 and the operator reverted it the same day: 5 req/min is below what a whole render needs, and the first live run peaked at 6/5 on `gemini-3.7-flash`, drew 429s and two 500s, and lost the render at SCRIPT. It returned on 2026-09-02 for **RESEARCH alone**, capped at four turns so the per-minute ceiling is never approached, with Groq as the fallback on any failure (§5.2.5). `GeminiLadderDriver` and `withGroqFallback` stay deleted — there is no ladder, and the fallback is Groq. Everything else on the reasoning path is Groq |
| **Groq Cloud** (`openai/gpt-oss-120b`) | Yes — rate-limited, no credit system. ~30 req/min, ~8k tokens/min, ~14.4k req/day, enforced per organization. **Limits are per-model, and the one that binds is tokens-per-day:** 200K for gpt-oss | **Yes** | **Every reasoning stage and every tool loop**, named once in `src/config/models.ts`. On `gpt-oss-120b`: retrieval reranking (§5.2.4), SCRIPT, PLAN (§5.4.5), EDIT's Kinocut loop (§5.5), and RESEARCH (§5.2.5) whenever its Gemini attempt does not land — the one and only place a second reasoning provider is tried first. On **`openai/gpt-oss-20b`, since 2026-09-03 (operator direction): CRITIC and EXPORT's title/description/hashtag listing.** Limits are per model per day, so those two stop competing for the 120b model's 200K; both are advisory or already fail soft to a heuristic, and CRITIC gains a second opinion from a model that is not SCRIPT's. EDIT and PLAN were offered and declined — EDIT is ~90-110K tokens a render across ~34 tool turns, which is where weak tool-calling degrades quietly into "every clip as sourced". **What remains on 120b costs ~130K a render, so two renders a day is the real ceiling**, and the fix is fewer EDIT turns rather than a smaller model. **Not footage acquisition** — that ran a browser agent on `qwen/qwen3.8-27b` (2M TPD) until 2026-08-29 and now makes no model calls at all (§5.0). Groq deprecated `llama-3.3-70b-versatile`/`llama-3.1-8b-instant` on 2026-06-17; the OpenAI open-weight models replaced them everywhere in `src/**` |
| **Microsoft Edge "Read Aloud" TTS**, via the `edge_tts` Python library (LGPL-3.0, `rany2/edge-tts`), invoked as a subprocess | Yes, but **not an official product** — no SLA, can break without notice | **Yes** | Narration voice synthesis + word-level timestamps for captions |
| **Google Gemini** (`gemini-3.1-flash-tts-preview`, TTS only) | Yes — and **the binding limit is 10 TTS req/day**, per day rather than per run. Also 3 TTS req/min and 10K TTS tokens/min; Pro TTS is not on the free tier at all. Measured from the operator's own AI Studio rate-limit export, 2026-08-31 | **Yes** | The expressive narration *upgrade* over Edge TTS, and **nothing else** — the text models were removed from the reasoning path on 2026-09-01 (row above). One TTS call per video, forced by that daily ceiling. **Edge TTS remains the default path** — Gemini returns no word timings, so it also costs an ALIGN call that Edge does not (plan v2 §4). Added 2026-08-31 on explicit operator instruction |
| **Cloudflare Workers static assets** | Yes | **Yes** | Hosts the operator console and its API |
| **Cloudflare D1** | 5 GB, 5M row-reads/day | **Yes** | Pipeline state, scripts, footage/segment/render/upload records, audit log |
| **Cloudflare KV** | 1 GB, 100k reads/day, **1k writes/day** | **Yes** | Hot manifests, rate-limit counters, encrypted key vault |
| **Cloudflare Turnstile** | Yes | **Yes** | Bot protection on any public POST route |
| **GitHub Actions** | 2,000 min/mo private, unlimited public | **Yes** | Weekly footage refresh, daily render pipeline, scheduler. FFmpeg and headless Chromium (Playwright) both run here — Workers cannot execute native binaries, launch a browser, or sustain multi-minute CPU jobs |
| **GitHub repo (orphan branch)** | Yes, subject to repo size sanity | **Yes** | The footage clip library. Not R2 — R2's free tier requires a card to activate at all; a rotating library of short trimmed clips fits comfortably in a git branch |
| **Reddit RSS/Atom syndication feeds, News RSS** | Yes | **Yes** | Zero-key trend sources — **not** Reddit's JSON/Data API, see §5.1 |
| **X (Twitter) API** | **No** — the free tier has no meaningful search access as of 2026 | N/A | Not in the default profile. Driver exists, disabled unless the operator has a paid tier |
| **YouTube Community tab** | No official API | **Yes**, but unofficial/fragile | Best-effort source, same fragility contract as `yt-captions` had in the old project |
| **Browser-driven footage acquisition** (headless Chromium, no model) | Yes | **Yes** | Weekly footage-source discovery *and* download (§5.0): Playwright searches youtube.com for `"<game name>" walkthrough "<channel name>" youtube` and reads the results off the page, then downloads the chosen video at **1080p** through one of two routes (§5.0): a pinned `yt-dlp` binary (default), or Playwright over the `media.ytmp3.gg` converter. One active channel (@HollowPoiint), whose ~1h episodes are what make 1080p affordable. Replaces the YouTube Data API v3 search. No API key, no cookies, no tokens |

**What this costs in practice:** effectively $0/month at 3 exports/day, with one caveat — Edge TTS is a free ride on an unofficial API, not a contractual guarantee. `config/providers.ts` keeps TTS behind the same driver interface as everything else specifically so a paid fallback (ElevenLabs, Groq TTS if it ships one) is a single env var away if Microsoft ever closes the endpoint off.

> Quotas and the Edge TTS endpoint's availability both change without warning. Treat every number here as **unverified at runtime**. `scripts/verify-quotas.mjs` re-checks the documented numbers against `src/config/quotas.ts` and warns on drift; it cannot detect an Edge TTS outage, only the pipeline's own retry/alerting can (§9).

---

## 1. Design principles

1. **Everything is a driver.** `llm.complete()`, `tts.synthesize()`, `downloader.fetch()`, `render.compose()`, `upload.publish()` are interfaces; providers are adapters selected by env, exactly as in the driver layer already built (`src/lib/drivers/**`). A provider swap is one new file and one env var.
2. **The repository is the database of record for the footage library.** Clips live on a git orphan branch with full provenance (source video id, channel, download timestamp, clip timestamp range) committed alongside them — not a mystery blob in someone's bucket.
3. **The pipeline is a state machine, not a prompt chain.** Every item — signal, script, render, upload — moves through explicit states with a persisted row. A crashed run resumes; it does not restart.
4. **Nothing uploads, ever — a human does.** The model *proposes* a script; a separate model pass *critiques* it; every render, regardless of score, reaches EXPORT (§9) packaged with the full audit trail behind it. No component in this system holds a YouTube upload credential. Autonomy stops at "produce a reviewable package," not at "publish" — the operator is the actual gate, and §9's AUDIT SUMMARY exists to make that five-second human judgment call well-informed instead of blind.
5. **Footage acquisition is isolated, rate-limited, and the only place third-party video is fetched.** The daily render pipeline never touches the network for footage — it only reads from the already-vetted library. This is a reliability control: a render job that doesn't depend on a live scrape can't fail because YouTube changed its page layout at 1pm.
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
                           │ gpt-oss-120b │    │ (unofficial, free)│  │  to the runner)│
                           └──────────────┘    └───────────────────┘  └──────┬────────┘
                                                                              │ finished .mp4
                                                                              ▼
   ┌─────────────────┐  weekly           ┌──────────────────────┐   ┌───────────────────┐
   │ WALKTHROUGH      │ ─────────────►   │ FOOTAGE REFRESH job   │   │  EXPORT: KV blob   │
   │ CREATORS         │  browser search  │  scene/motion scoring │   │  (mp4 + audit_json,│
   │ (long-form guides)│  + ytmp3 download│  → clip candidates    │   │  3-day TTL)        │
   └──────────────────┘                  └──────────┬────────────┘   └─────────┬──────────┘
                                                      ▼                          ▼
                                        ┌─────────────────────────┐   console review queue
                                        │ git orphan branch:       │   ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄▶
                                        │ assets-library (clips +  │   you, manually, via
                                        │ provenance metadata)     │   YouTube Studio
                                        └─────────────────────────┘
```

**Why GitHub Actions is the runner and not a Worker:** unchanged reasoning from MythosEngine, stronger here — FFmpeg rendering and the headless-Chromium footage-acquisition agent need a real filesystem, real CPU minutes, and the ability to execute a native binary/launch a browser, none of which Workers offer.

---

## 3. Provider abstraction

`config/providers.ts` is the only file that knows brand names — already built this way (see Phase 1 commit). Extended for this pivot:

```ts
export const LLM_DRIVERS      = ['groq', 'workers-ai', 'openai-compat'] as const;
export const TTS_DRIVERS      = ['edge-tts', 'elevenlabs', 'none'] as const;
export const DOWNLOAD_DRIVERS = ['ytmp3-dom'] as const;
export const RENDER_DRIVERS   = ['ffmpeg-local'] as const;
export const EXPORT_DRIVERS   = ['kv-blob'] as const;
export const CACHE_DRIVERS    = ['kv', 'memory'] as const;
```

**Default profile (`profiles/free.env`)** — the only profile that has to work:

```
LLM_DRIVER=groq
TTS_DRIVER=edge-tts
DOWNLOAD_DRIVER=ytmp3-dom
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
  ttlSeconds: number; // 2 days by default — see §9
}
export interface ExportStoreResponse {
  key: string;
  sizeBytes: number;
}
```

No `UploadDriver` exists in this system. There is no automated publish path — see §9.

`RenderDriver` shells out to `ffmpeg` via `node:child_process` — not an npm package, so the "run `npm view`" rule doesn't apply, but the equivalent applies: pin `ffmpeg`'s version explicitly in the GitHub Actions workflow, the same supply-chain discipline for a non-npm binary dependency. `DownloadDriver` (`src/lib/drivers/download-ytmp3-dom.ts`) is Playwright-driven instead — `playwright` is a real npm dependency (verified per the import rule: created 2015-01-23, maintained by the Playwright/Microsoft team), pinned in `package.json` like every other dependency; Playwright ties the downloaded Chromium build 1:1 to the installed npm package version, so there's no separate binary checksum to pin the way `yt-dlp` needed.

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
  trace_id      TEXT,                        -- the runs.trace_id that wrote it; the console's run view hangs a run's videos off this (§6). Nullable: pre-2026-08-31 scripts have none
  beats         TEXT,                        -- JSON [{move, text}] (§5.3). Nullable, and the nullability IS the format boundary: a row with beats is a v2 discourse script, a row without is v1 prose. JSON rather than a child table because a beat has no identity — nothing references, updates, filters or joins on one, and the list is only ever read whole
  target_duration_s INTEGER,                 -- seconds of narration the script was written for (60-180). Null on v1 prose rows, which were always ~47s
  created_at    TEXT NOT NULL                -- drives "today's diversity" queries, §5.3/§5.6
);

CREATE TABLE research_briefs (                -- RESEARCH (§5.2.5): what SCRIPT was grounded in
  id            TEXT PRIMARY KEY,
  signal_id     TEXT NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
  summary       TEXT NOT NULL,
  key_points_json TEXT NOT NULL,              -- JSON string[]
  citations_json  TEXT NOT NULL,              -- JSON [{signal_id, claim, title, url, source_kind}]
  model         TEXT NOT NULL,                -- which model produced the brief
  tool_calls_json TEXT NOT NULL,              -- JSON string[] — the tools it actually ran
  created_at    TEXT NOT NULL
);
-- Its own table rather than columns on `scripts` because it is evidence,
-- not draft content: §9 requires the export to show a reviewer what the
-- script was grounded in, and a brief outlives a rewritten script. A signal
-- with no row here was scripted ungrounded — a supported, flagged state.

CREATE TABLE footage_sources (                -- tracked long-form walkthrough channels
  id            TEXT PRIMARY KEY,
  channel_url   TEXT NOT NULL,
  game          TEXT NOT NULL,                -- 'minecraft' | 'subway-surfers' | 'gta-v' | ...
  license_note  TEXT NOT NULL,                -- operator's own recording, explicit reuse grant, etc.
  enabled       INTEGER NOT NULL DEFAULT 1    -- retire a channel by flipping this, never by DELETE
);
-- `enabled` mirrors `sources.enabled`. Deleting a footage_sources row would
-- either fail against renders' restricting FK or destroy the provenance of
-- exports the operator has already reviewed, which §9 forbids. Both FOOTAGE
-- REFRESH (§5.0) and FOOTAGE SELECT (§5.5) filter on it, and so does the
-- console's footage-health count — a retired channel's segments are not
-- inventory, because nothing can claim them.

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
  expires_at    TEXT NOT NULL,                 -- created_at + 2 days; db/exports-reap.ts enforces the deletion (R2 has no per-object TTL)
  status        TEXT NOT NULL CHECK (status IN
                  ('ready_for_review','downloaded','reviewed','discarded','expired'))
);

CREATE TABLE runs (                          -- observability, same shape as before
  id            TEXT PRIMARY KEY,
  started_at    TEXT NOT NULL, finished_at TEXT,
  stage         TEXT NOT NULL, status TEXT NOT NULL,   -- running|succeeded|failed|degraded|skipped|queued
  tokens_in     INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0,
  error_class   TEXT, trace_id TEXT NOT NULL
);
-- `degraded` (2026-09-03) separates "the stage did not do its job and the render
-- carried on" from "the stage failed and took the render with it". RESEARCH, PLAN,
-- ALIGN, EDIT, HOST and CRITIC are all contractually allowed to fail without costing
-- the video, and all six closed their row `failed` — so `statusOf` reported a render
-- that degraded exactly as designed, produced a video and exported it as "The run
-- failed" on stage 4. Both statuses still carry `error_class`; only the aggregate
-- verdict differs. Free text, deliberately: a new stage writer must not break the read.
-- One row per invocation is not a stage at all: `pipeline` (db/runs.ts, 2026-09-03) is
-- opened before RESEARCH and closed after EXPORT, and `statusOf` asks it first. Stage
-- rows can only speak while a stage is open, so *between* two of them every row a live
-- run had written was closed and stage 4 read the run as finished — it froze on
-- `EDIT · SUCCEEDED`, `0 / 1 exported`, and stopped polling two seconds before RENDER
-- opened its row (observed 2026-09-03). A killed job leaves the row `running`, which
-- `reapStaleRuns` already sweeps.

CREATE TABLE run_picks (                     -- the operator's guided-run picks (§6); RENDER claims them in order
  id            TEXT PRIMARY KEY,
  plan_id       TEXT NOT NULL,               -- one submission of the run form
  position      INTEGER NOT NULL,            -- the operator's ordering within that plan
  topic         TEXT NOT NULL,               -- one of ideas.ts's TOPICS; deliberately not a CHECK — the topic list is a product decision that will move
  signal_id     TEXT NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
  status        TEXT NOT NULL CHECK (status IN ('queued','claimed','cancelled')),
  claimed_trace_id TEXT, claimed_at TEXT,    -- which run took it
  created_at    TEXT NOT NULL
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

**Atomic multi-statement writes from the pipeline go through the Worker (resolved 2026-08-30).** `execAtomic` needs statements that are both parameterized *and* atomic. Inside the Worker that is `D1Database.batch()`, a real transaction. From the GitHub Actions runner there was no equivalent: D1's REST `/query` endpoint answers `7400: The request is malformed: params with multiple statements is not supported` — it takes *either* several statements *or* bound parameters, never both, and exposes no batch primitive. That is what broke every multi-statement write from the runner, `generateScript` included, so SCRIPT could not persist and the pipeline could not reach RENDER.

Of the three ways out — inline escaped literals (throws away parameterization), sequential non-atomic writes (forbidden by `CLAUDE.md`), or send the batch to the process that holds the real binding — the third was taken (operator decision, 2026-08-30). `db/worker-batch.ts`'s `WorkerBatchClient` POSTs the statement list to `POST /internal/d1/batch`, which `src/server/internal/d1-batch.ts` executes through the Worker's own `execAtomic`. Both properties survive the trip.

`D1HttpRawClient` was **deleted** rather than left in place throwing: a class that compiles, type-checks, and fails only against the live database is a trap, and this one had already cost a month of scheduled RENDERs. Single-statement reads still use `createD1HttpDb` over the REST API directly — they need no transaction.

The endpoint is a deliberately narrow surface with a real key on it, because it can run arbitrary SQL: a dedicated `PIPELINE_BATCH_TOKEN` bearer secret compared in constant time over SHA-256 digests (no length or prefix leak), **fail-closed when that secret is unset** — an unconfigured deployment answers 503 rather than opening — hard caps on statement count, combined SQL size and parameter count, an `audit_log` row per call under a new `pipeline` actor recording the SQL but never the bound parameters, and no acceptance of a console session in its place, so a stolen console cookie never becomes an arbitrary-SQL capability.

**Reading one row: `getOne()`, never `.get()`.** `AppDb` spans three dialects, and drizzle's `.get()` does not behave the same on all of them. Over the D1 HTTP client (the GitHub Actions arm), a query matching nothing hands the sqlite-proxy dialect an empty array; `mapGetResult` only short-circuits on a *falsy* `rows`, and `[]` is truthy, so it builds a row object with every field `undefined`. A miss therefore comes back truthy and every `if (!row)` guard stops working. RENDER failed on every scheduled run from 2026-08-29 to 2026-08-31 with `"undefined" is not valid JSON` — `getSettings` handing a ghost row's `compiledJson` to `JSON.parse` — and the quieter cases (an unmatched credential, MCP token, or export) were failing the whole time without saying so. `db/client.ts`'s `getOne()` uses `.all()[0]`, which maps an empty result identically on all three dialects.

**Joining: in memory, never in SQL.** Same root cause, worse consequence. Drizzle emits an unaliased select list for a join (`"signals"."id", ... "sources"."id"`), and D1's REST response is a column-keyed JSON *object* — so two columns named `id` collapse into a single key before the client ever sees them. The row then arrives one value short, and `Object.values` shifts every field after the collision by one. Checked against the live database on 2026-08-31: the surviving `id` was the *source's*, not the signal's, and the title landed in `canonical_url`. Nothing downstream can detect this; it simply reads the wrong data confidently. The information is destroyed server-side, so there is no client-side fix — `src/lib/rag/retriever.ts` and `scripts/pipeline/render.ts` query each table and join with a `Map`. Both hazards are pinned by tests in `db/d1-http.test.ts`, so a future drizzle release that aliases its join columns will fail them and make the workaround revisitable.

Same rationale as before: natural-key `UNIQUE` gives idempotency for free, `CHECK` makes illegal states unrepresentable, `audit_log` is append-only, `footage_segments.used_count`/`last_used_at` is what lets FOOTAGE SELECT (§5.5) rotate clips instead of reusing the same 15 seconds every day, and `renders.created_at`/`scripts.created_at` are what let the diversity logic (§5.3/§5.5/§5.6) know what's already run today without a separate tracking table.

The block above is the pipeline's core; the console added more tables as it
was built — `chat_sessions`/`chat_messages` (§8), `mcp_tokens` (§6's
`POST /console/mcp`), `reauth_nonces`, `webauthn_challenges`,
`recovery_codes`. **`db/schema.ts` is the source of truth, not this
document.** Read it, not this section, before writing a query.

### How a migration reaches production

`db/schema.ts` → `drizzle-kit generate` → a numbered file in
`db/migrations/` → **`wrangler d1 migrations apply mythosengine --remote`,
run by `.github/workflows/ci.yml`'s `deploy` job, before `wrangler deploy`.**

That ordering is the contract: a Worker is never deployed ahead of the
schema its code expects. Two properties make it safe to leave on —
`wrangler` skips anything already recorded in the `d1_migrations` ledger, so
a push with no new migration is a no-op, and `wrangler.toml`'s
`migrations_dir = "db/migrations"` uses the default `<dir>/*.sql` pattern,
which matches Drizzle's flat filenames and ignores its `meta/`
subdirectory. The two tools agree on one file set.

**Why this is automated rather than a runbook step:** migrations used to be
applied by hand with `wrangler d1 execute`, and on 2026-08-29
`0007_mcp_tokens.sql` was missed. The Worker shipped code that selected from
`mcp_tokens`; D1 didn't have it. `getConsoleSummary()` fans out with
`Promise.all`, so that one dead query rejected the whole call, the router's
catch-all turned it into a 500, and **every** card on the dashboard fell to
"Unavailable" under a "Console API not reachable" banner — a total console
outage from a missing `CREATE TABLE`. The chat agent's `get_summary` tool
failed the same way (§8). A schema that only production can disagree with is
a schema that will.

---

## 5. Pipeline stages — contracts

### 0. FOOTAGE REFRESH (weekly cron — the only stage that touches third-party video)

**Browser-driven source discovery** — built, not proposed. A real headless
Chromium (`src/lib/drivers/browser-session.ts`) replaces the YouTube Data
API v3 search, which is removed along with `YOUTUBE_API_KEY`. Downloading is
a separate concern with two routes, described under "Two acquisition routes"
below; `yt-dlp` was removed on 2026-08-28 and reinstated as one of those two
on 2026-08-30 (operator directive). `YOUTUBE_COOKIES` remains removed — no
route here is configured with cookies.

**Both legs are deterministic. This job makes no model calls at all**
(revised 2026-08-29, operator directive). Search went first, when per-action
logging showed the agentic searcher calling `browser_list_links` and getting
**340 bytes — an empty list** — because navigation waited for
`domcontentloaded` while YouTube renders results client-side *after* it. It
was spending four Groq calls per source, each carrying a page snapshot and
~960 tokens of tool schemas against the quota that binds this tier (§10), to
look at a page with nothing on it.

The download leg was kept agentic at the time on the theory that driving a
third-party converter genuinely varies. Driving the live page by hand showed
otherwise: `media.ytmp3.gg` is a small, id-addressed state machine with one
right answer at every step, and "wait for the conversion" is a poll on the
page's own status, not a judgement call. So the model came out of that leg
too, and `browser-agent-core.ts` / `download-agentic-ytmp3.ts` were deleted
rather than left dormant. FOOTAGE REFRESH now costs **zero tokens end to
end**, and reports real, typed failures instead of a confident guess.

**What the page actually is** (read off the live site with a real browser on
2026-08-29 and exercised end to end, which is where every selector below
comes from):

```
#videoUrl + .format-btn (MP3|MP4) + #quality-select + #copyright-consent-checkbox
     │  #submit-button
     ▼
.status   "Checking copyright protection…" → "Preparing the video…" →
          "Checking video source…" → "Analyzing video details…" →
          "Processing... 59%" → "Merging... 100%" → "Ready to download"
     │
     ├──► #download-btn[data-url][data-duration][data-filename]   ready
     └──► .status--error + #retry-btn                             failed
```

Measured: ~3.5–10s when ytmp3 has the conversion cached, **~197s for a fresh
4h37m source**, and a *bad* video id sits silent for ~20s before the page
admits the failure. That last one is why the wait is a bounded poll on the
page's own state and not a fixed sleep — and why a timeout is a first-class,
typed outcome rather than a hang.

1. For each `footage_sources` row, `DomYoutubeSearchDriver`
   (`youtube-search-dom.ts`) navigates to
   `youtube.com/results?search_query=...` for
   `"<game>" walkthrough "<channel>" youtube`, **waits for a real watch link
   to exist**, then reads YouTube's own embedded `ytInitialData` for up to 3
   candidates with structured duration and view count (falling back to plain
   anchors if that blob is absent). The tree-walk is a pure function
   (`collectVideoRenderers`) over data the page hands back, not logic running
   inside `page.evaluate` — browser-context code is invisible to coverage and
   awkward to test. No model call, no API key, no cookies. Every id is still
   verified against `extractYoutubeVideoId` before being trusted: scraped
   page data is untrusted input exactly as model output was.

**Two acquisition routes (2026-08-30).** `DownloadDriver` has two implementations and the choice is made at one call site, `buildDownloadDriver` in `scripts/pipeline/footage-refresh.ts`, from `FOOTAGE_DOWNLOADER`:

| Route | Module | State |
|---|---|---|
| `ytdlp` (default) | `src/lib/drivers/download-ytdlp.ts` | pinned, checksummed `yt-dlp` binary; verified end to end 2026-08-30 |
| `ytmp3` | `src/lib/drivers/download-ytmp3-dom.ts` | Playwright over `media.ytmp3.gg`; verified working from a residential IP 2026-08-30, blocked from GitHub-hosted runners |

Why two. `media.ytmp3.gg` began answering GitHub-hosted runners with a "Service Discontinued" modal over the converter form while serving a working page, with no overlay, to residential addresses — six consecutive refresh runs failed, the last three in about two minutes each, too fast to be conversion trouble. The driver was not at fault and was measured to prove it: driven unmodified from a residential IP it converted and downloaded a validated 1080p file in 41 seconds. **The variable was where the browser ran, not what it did**, and no amount of correct driver code addresses that. So `yt-dlp` was reinstated as a second route by operator directive rather than the converter being patched, and the converter was kept rather than deleted: a second route that works from a different place is what makes the next such block survivable.

This reverses the 2026-08-28 removal of `yt-dlp`, and did not undo the reason for it. That driver was losing to YouTube's bot check, and it still does: measured on a GitHub-hosted runner 2026-08-31 (run `33366544395`), yt-dlp is answered with `Sign in to confirm you're not a bot` for the same channel it downloads without complaint from a residential address.

**So both routes fail from a GitHub-hosted runner, and for the same underlying reason — a datacenter IP.** ytmp3 shows a "Service Discontinued" modal; YouTube shows a bot check. Neither is a driver defect, and building a third route would meet the same wall. The job therefore runs on a **self-hosted runner** (`runs-on: [self-hosted, mythos-footage]`), which is the only change that addresses the actual variable. Only FOOTAGE REFRESH needs this; RENDER and WATCH stay on GitHub-hosted runners because nothing they touch is IP-gated.

That same run is also what confirmed the error taxonomy is worth having: of three candidates, one was correctly refused as **age-gated** (`policy_violation`, try the next video) and one as a **bot check** (`provider_error`, the runner is in the wrong place). Both of YouTube's messages begin "Sign in to confirm", and an earlier substring match reported the age gate as a bot check — which would have sent the operator to rebuild their CI over a single unusable candidate.

Two properties of the `yt-dlp` route are better than the converter's: duration is checked from `--dump-json` **before a byte is downloaded**, so an over-long source costs one cheap metadata call instead of gigabytes; and the output path is taken from yt-dlp's own `--print after_move:filepath` rather than reconstructed from a template, which merging and remuxing can both invalidate. Format selection prefers H.264 explicitly — `[ext=mp4]` alone selects AV1, which YouTube also serves in an mp4 container, and AV1 decodes several times slower on the CPU-only runners that then decode every frame twice (motion scoring, then clipping).

Everything downloaded by either route is validated the same way, by the shared `probeVideo` in `src/lib/drivers/probe-video.ts`: a real video stream and a finite duration, before the duration ceiling is enforced against that *measured* value. The two routes differ entirely in how they obtain a file and not at all in what makes one acceptable.

**Verified end to end 2026-08-30**, whole leg, live: search read three @HollowPoiint candidates off youtube.com; the first was refused as age-gated and the next downloaded (44 min, 1080p H.264); head/tail trim, motion scoring, clipping, provenance and the `assets-library` commits all ran; two 65-second 1080p clips landed in the library with matching `footage_segments` rows, in 427 seconds. `footage_segments` is no longer empty.

**Two things the live site does that the fixture had to learn** (both found on 2026-08-31, the first real run on the deterministic driver):

- A **service notice** — `<div aria-modal="true" role="alertdialog" id="service-notice-overlay">` — is served to the GitHub Actions runner (but not to a residential IP, checked repeatedly) and intercepts every pointer event on the form beneath it. Its heading, read off the runner on 2026-08-31, is **"Service Discontinued"**. See the box below — this is a live blocker on footage acquisition, not a driver defect. The driver closes a *dismissible* notice, matching the control by its **accessible text** rather than by a selector for a dialog nobody here has been served; when nothing matches it leaves the overlay standing, because clicking an unread button or deleting a notice a service chose to show are both worse than failing with the evidence attached. Crucially, a form interaction that fails now **re-reads the overlay and reports its words** — the first three runs all said "the page's layout may have changed" while the page was plainly saying something else, and that misreading cost the whole diagnosis.
- A failed conversion renders `.status--error` **beside `#retry-btn`** — the site's own signal that the failure is transient. The driver takes that offer up to `maxConversionAttempts` (3). A *timeout* is not retried: the conversion is still running somewhere, and restarting only spends the budget twice.

2. `DomYtmp3DownloadDriver` (`download-ytmp3-dom.ts`) skips a candidate
   whose video id is already in `footage_segments` (unchanged behavior),
   otherwise navigates to
   `https://media.ytmp3.gg/tools/youtube-to-mp4-converter/dbismy` and drives
   it by id: select **MP4** (the page defaults to MP3 — without this step the
   pipeline would download audio and fail the video-stream check below),
   pick the video quality through the visible dropdown and *assert the app
   followed* by reading `#quality-select` back, tick the copyright
   attestation (see below), fill `#videoUrl`, submit, then poll until the
   page publishes a file URL or shows its error state. Each new `.status`
   line is logged once — this job's only evidence is CI stdout, and
   "Merging... 100%" every few seconds is what distinguishes a slow
   conversion from a hang.
3. **Pre-flight duration check, then ffprobe.** The ready state's
   `data-duration` attribute is the source's length in seconds (matched a
   known 634.6s video to within one second), so a candidate over
   `maxDurationS` is rejected **before a byte is downloaded** — something the
   agentic driver could not do, and which matters because a multi-hour
   walkthrough at 1080p is measured at ~27 MB per minute of source. The file
   is then downloaded by streaming `fetch` straight to disk (never buffered
   in memory, and never through a browser click: ytmp3 serves each conversion
   from a fresh throwaway host that the navigation allowlist would correctly
   abort), under a hard byte ceiling, and validated with `ffprobe` before
   it's trusted at all — a real video stream and a finite duration —
   with `maxDurationS` enforced again against that *measured* duration.
   Everything the page says stays untrusted until the file itself agrees.
4. **Head/tail trim, immediately.** The first and last 10 minutes come off
   the download the moment it lands, before anything is scored or clipped,
   and the full source is deleted right then (`trimHeadTail` in
   `src/lib/footage/clip.ts`). Those minutes are intro, recap, outro and
   subscribe card on every walkthrough episode — none of it usable gameplay.
   Doing it as a cut rather than as a bias in the window search means the
   discarded footage is *gone from disk*, not merely unselected: nothing
   downstream can reach it by accident. Stream-copied, so it costs seconds
   rather than a full re-encode; the cut lands on the nearest preceding
   keyframe, which against a 600s buffer is noise. Timestamps recorded as
   provenance add the offset back, so `footage_segments.clip_start_s` is a
   moment in the *source* video a reviewer can scrub to.
5. FFmpeg motion-scoring pass (frame-difference/`signalstats` over a sliding
   window) ranks candidate windows in the trimmed body; the job then draws
   its clips **at random from the top-ranked shortlist** rather than always
   taking the top few. Ranking still decides what is eligible — no loading
   screens, no static cutscenes — and chance decides which eligible window
   is taken, because `findTopMotionWindows` is deterministic and a channel
   whose top video hasn't changed would otherwise yield the identical
   moments every week. Clips are **65 seconds** (a Shorts narration runs
   ~60s, so one clip covers a whole render without RENDER's `-stream_loop`
   ever visibly wrapping), written to the `assets-library` orphan branch with
   commit metadata (source video id, channel, timestamp range), and inserted
   as `footage_segments` rows. Both the download and the trimmed body are
   deleted afterwards — the library holds only the transformed segments,
   never the source video.

**Source eligibility** (operator directive, 2026-08-30). `footage_sources`
has exactly one enabled row: `hollowpoiint-gta` (@HollowPoiint). His episodes
run about an hour, and that length is the whole reason 1080p is affordable —
at the measured ~27 MB per source-minute, a 1h source is ~1.6 GB against the
driver's 6 GB ceiling. The retired channels' top candidates measured 4h37m,
17h25m and 14h40m: the first is ~7.6 GB and is rejected by the byte ceiling,
the other two never download at all. So a candidate outside **1265s–7200s**
(both 10-minute buffers plus a clip, up to 2 hours) is now rejected on the
search result's own stated duration, before a byte moves. The retired rows
are `enabled = 0`, not deleted — see §4.

**Why this job used to hang, and what survives of that fix** (2026-08-29,
after every weekly run had silently failed): the agent's prompt grew
monotonically — each iteration appended a page snapshot or a link list, and
nothing was ever dropped. `GroqDriver` prices a request at
`maxTokens + promptChars / 4` against `TokenBucketLimiter`'s
6,000-tokens/minute bucket, so crossing ~20,000 characters (`(6000 - 1024) * 4`)
made every call cost a full bucket. Worse, `acquire()` waited for a budget
`refill()` caps out of reach, so it **never resolved** — the job sat with an
idle Chromium emitting nothing for 30 minutes until the Actions timeout
killed it, every time. Removing the agent removed the prompt, but two of the
three fixes are general and stay:

- `TokenBucketLimiter.acquire()` clamps a demand larger than the whole
  per-minute budget instead of deadlocking on it. A local pacing bucket
  cannot know a provider's real per-request ceiling; it should throttle hard
  and let Groq's own 429/413 be authoritative, never hang. This still guards
  every remaining Groq caller.
- `scripts/pipeline/footage-refresh.ts` logs per source and the download
  driver logs every `.status` change. This job's only evidence is CI stdout,
  and it previously produced none at all — a hang and slow progress were
  indistinguishable.
- The third fix (snapshot/link caps and `trimAgentHistory()` in
  `browser-agent-core.ts`) went with the module it belonged to.

**Guardrails on the browser drivers** (ytmp3.gg is a third-party,
ad-monetized converter site): navigation is restricted to one allowed origin
per acquisition — youtube.com for search, media.ytmp3.gg for conversion — and
any top-level navigation elsewhere (an ad redirect, a popup) is aborted
before it loads, popups are closed unopened; every element is addressed by id
or class through `page.locator`, which only ever sees the main frame's own
DOM, never a 3rd-party iframe's content; every wait is bounded
(`actionTimeoutMs`, `conversionTimeoutMs`, `downloadTimeoutMs`) so a changed
page layout fails typed and fast rather than hanging the job; the download is
capped by `maxDownloadBytes` (default 6 GB) so a runaway source cannot fill
the runner's disk; and nothing downloaded is ever executed — only probed by
`ffprobe` and, if valid, handed to `ffmpeg`.

**The copyright attestation is an operator decision, not a driver default.**
ytmp3.gg gates its Convert button behind a checkbox reading *"I confirm that
I have read and agree to the standards in the Copyright Disclaimer and will
not download copyrighted content."* `DomYtmp3DownloadDriver` defaults
`acceptCopyrightAttestation` to **false** and refuses immediately when it is
off, because ticking it is an assertion made to a third party and this
project's own `footage_sources.license_note` rows describe the material as
copyrighted walkthrough footage used under an explicitly accepted risk ("not
a claim of zero risk"). Those two statements contradict each other. It is
enabled in exactly one place — `scripts/pipeline/footage-refresh.ts`, with
the reasoning written at the call site — so the choice stays visible and
deliberate.

Isolating footage acquisition to one weekly, low-volume job keeps the
library clean, curated, and dependable — same rationale as before this
change, unaffected by which acquisition mechanism runs inside that job.

### 1. WATCH (hourly cron)
- **Seeds `sources` from `data/sources.yml` first, every run** (idempotent).
  That file is the committed source of truth for what WATCH monitors, so the
  table follows the file rather than depending on someone having run a
  seeding command once. Until 2026-08-29 nothing called `seedSourcesFromYaml`
  at all — it was written and unit-tested in Phase 3 and never wired up — so
  production's `sources` table was empty, WATCH polled nothing, and it
  reported no failure because there was genuinely nothing to poll. A stage
  that does nothing successfully is the worst kind of broken: the console
  showed an honest zero and there was no error anywhere to chase.
- Subreddit RSS/Atom feeds (`reddit.com/r/<sub>/hot.rss`) via the generic RSS driver, real User-Agent, conditional GET where the server supports it (many don't send an ETag — the natural-key idempotent insert covers that case regardless). **Deliberately not Reddit's JSON/Data API**: blocked outright from at least some cloud IP ranges (confirmed by testing, not assumed). News RSS, best-effort YouTube Community scraping (typed, fails safe like `yt-captions` did). X disabled in the free profile — no viable free API.
- Output: `signals` rows in `observed`.

### 2. SCORE
- Engagement-velocity scoring (upvote/comment growth rate, freshness decay), simhash dedupe against the trailing 7-day window.

### 2.5. RESEARCH (Gemini `gemini-3.7-flash` first, Groq `gpt-oss-120b` on any failure — tool-calling RAG)

Added 2026-08-30 by operator directive. Between SCORE and SCRIPT, the picked
signal becomes a **grounded brief**: what is actually being said about the
topic, and which retrieved source supports each claim.

**Two providers, one stage** (operator direction, 2026-09-02). RESEARCH is
the only reasoning stage that is *intake*-bound rather than reasoning-bound:
on Groq the whole growing tool conversation must fit inside a 7,200-token
per-request ceiling, and `fitToRequestBudget` gets there by discarding tool
results the model already fetched. Gemini's intake does not require that, so
it gets the first attempt. Everything else — reranking, SCRIPT, CRITIC, PLAN,
EDIT, EXPORT's listing — stays on Groq permanently.

| | Gemini attempt | Groq fallback |
|---|---|---|
| Model | `gemini-3.7-flash` | `openai/gpt-oss-120b` |
| Tool-loop turns | **4** | 6 |
| Per-request ceiling | 60,000 tok (self-imposed) | 7,200 tok (a real 413) |
| `read_source` returns | 24,000 chars | 6,000 chars |
| `search_discourse` returns | 16 candidates | 8 |
| HTTP retries | **none** (`maxAttempts: 1`) | `fetchWithRetry` default |

**Why this is not the 2026-09-01 arrangement returning.** That one put five
stages on Gemini and lost a render at SCRIPT. Three things differ:

1. **Four turns, not six.** The free tier meters 5 requests/minute per model.
   RESEARCH's full loop is six, so the old arrangement crossed the ceiling
   inside a single stage — it peaked at 6/5. Four cannot reach it, so the
   attempt never waits on a limiter and never meets a 429. The limiter in
   `createGeminiResearchDriverFromEnv` guards only the case the cap cannot
   see: two renders dispatched inside one minute.
2. **Fall back on _any_ failure.** The deleted `withGroqFallback` fell back
   only on quota exhaustion, so the two `500 InternalServerError`s that run
   drew went straight through it. A 500, a 429, a timeout, malformed JSON, a
   brief that fails schema validation, and a loop that never stops calling
   tools are now the same event: stop asking Gemini, ask Groq.
3. **No ladder.** Descending to 3.6 Flash for the remaining turns would buy a
   separate per-model bucket. Considered and declined 2026-09-02: Gemini tool
   transcripts carry signed `thought` steps and whether a second model
   accepts the first's signatures is untested, so the failure would be a bare
   `invalid_request` appearing only in production.

The Gemini path needs `LlmMessage.providerSteps` — an opaque transcript the
loop echoes back untouched — because Gemini's Interactions API cannot replay
a tool conversation statelessly: its responses interleave `thought` steps
carrying a signed `signature`, and a turn rebuilt from `content` +
`toolCalls` is rejected with a bare `invalid_request` naming nothing. The
loop carries both replay shapes on each assistant turn, and each driver
reads the half it understands.

Without `GEMINI_API_KEY` this is exactly the Groq path, unchanged and
unslowed — the same rule that governs the TTS upgrade. **It also moved off
`gpt-oss-20b`** on 2026-09-01 and onto the same 120b model as every other
stage, so the token budgeting below shares one 200K/day rather than borrowing
a second model's.

Which provider actually answered, and why the other did not, is recorded in
the audit package as `stages[].provider` / `stages[].fallbackReason` (§9).

**Retrieval is reranked before the agent sees it** (`src/lib/rag/rerank.ts`,
added the same day — "for RAG calling and for ranking too"). BM25
finds candidates cheaply and is blind to whether a headline is *about* the
query: searching for "prison overcrowding" it will rank "the overcrowding of
the prison of self-regard" above a sentencing-reform report, because the
first says both words. The model reorders; it may **only** reorder what
retrieval returned, so it can never introduce a citation the brief would then
fail to verify. A reranker that errors or answers badly leaves the BM25 order
in place. `RerankingRetriever` wraps the `Retriever` seam rather than editing
`SignalsBm25Retriever`, so the BM25 tests keep testing BM25.

**Shape.** The model's own tool-calling is the reasoning core; the RAG pipeline is
wrapped as two ordinary functions behind it. No agent framework is involved —
the loop in `src/lib/rag/research.ts` is about thirty lines, and CrewAI or
LangGraph would add a dependency and an indirection without adding a
capability this needs.

| Tool | Backed by | Returns |
|---|---|---|
| `search_discourse(query, limit)` | BM25 over the `signals` corpus (`src/lib/rag/bm25.ts`, `retriever.ts`) | signal ids, titles, source kind, dates |
| `read_source(signal_id)` | `ArticleFetchDriver` (`src/lib/drivers/article-fetch.ts`) | the page's readable text, capped at 6,000 chars |

**Why BM25 and not embeddings.** Groq serves no embeddings endpoint, so a
vector index would mean a second provider or a ~100MB local model in every
Actions run — and `EmbedDriver`/`VectorDriver` are still honest stubs
precisely because nobody has built the recall eval set that would say whether
embeddings retrieve better *here*. BM25 needs no model, no network and no
state, ranks well on the short keyword-dense titles this corpus is made of,
and every number it produces can be checked by hand. `Retriever` is the seam
an embedding index slots into later without the agent changing.

**Two properties the stage is built around:**

1. **It cannot invent a citation.** Every citation is checked against what
   retrieval actually returned before the brief is accepted; ones that aren't
   are dropped, and a brief left with none is rejected outright. A brief
   whose grounding is fabricated is *worse* than no brief, because it reads
   as sourced. A model that answers without searching therefore fails
   closed — with nothing retrieved, nothing is citable.
2. **It is allowed to fail.** A retrieval outage, a rate limit, or a model
   that cannot produce a citable brief costs the render its grounding and
   nothing else: SCRIPT falls back to writing from the signal title, AUDIT
   SUMMARY (§9) flags the export as ungrounded, and the day's video still
   ships. Losing it to a failed research call would be the worse trade.

**The model never names a URL.** `read_source` takes a signal id and resolves
it — and only against ids `search_discourse` returned *in that same run*, not
against the whole table. A guessed id is a typed miss, never an outbound
fetch. The driver's scheme/private-host checks are the second layer, for a
`canonical_url` that is itself junk; scraped feed data is untrusted input the
same way scraped video ids are (§5.0).

Output is persisted to `research_briefs` (§4) and travels into the export's
`audit_json`.

### 3. SCRIPT (Groq, `openai/gpt-oss-120b` — `llama-3.3-70b-versatile` deprecated by Groq 2026-06-17)
- **Beats, written to a duration** (built 2026-08-31, reshaped 2026-09-03). Emits `{hook, beats: [{move, text}], open_question}`, written to a requested duration (`directives.compiled_json.target_duration_s`, 60–180s) rather than a word count. Word count becomes derived.
- `move` is what replaced the second speaker when the format was cut to one host, and every downstream stage varies on it: TTS delivery direction, caption emphasis, and where the footage cuts. The vocabulary is `question · attempt · pushback · reframe · land · open` (the discourse arc) plus `setup · turn · escalation · evidence · verdict · confession · aside · punchline`, which is what the other formats actually do.

#### 3.1 There is no structure gate (operator direction, 2026-09-03)

SCRIPT used to enforce the discourse arc: at minimum one `pushback` between an `attempt` and a `land`, on pain of failing the render. **That gate is gone**, along with `validateBeatStructure`, `BeatStructureViolation` and the `fatal`/`advisory` split that briefly replaced it.

The reasoning is worth keeping, because the gate was not obviously wrong. It encoded a real editorial belief — that a host who is never wrong is lecturing — and it was added precisely because one host with no disagreement drifts into flat narration. What it could not do was describe more than one shape. A story does not push back. An escalation has nothing to be wrong about. A hot take states its verdict first and concedes once, in the wrong order. Enforcing the discourse arc did not make scripts better; it made every script a discourse, and it did so by *throwing away finished renders* — which is how it came to be looked at (2026-09-03, `SCRIPT failed: script failed the discourse structure gate after 2 attempts`).

What replaced it is a die, not a rule: `SCRIPT_FORMATS` in `src/lib/pipeline/performance.ts` — `discourse · story · hot_take · myth_bust · confession · escalation` — one rolled per render. Discourse is still there and still good; it now competes on merit rather than by being the only shape the gate would accept.

**Length is a guide, not a gate.** `reviewScript` returns at most one advisory, the ±25% read-time band, and a draft that misses gets exactly one rewrite quoting the word count to aim at. Whichever of the two drafts lands closer is the one that ships, and a script that misses twice still ships. The estimator is a single 165-wpm constant standing in for delivery speed, pauses and `ttsRateRange` — and it is now *knowingly* low, because non-verbal sounds take real time in the audio and none in the word count. AUDIT SUMMARY flags the miss from `wordCountRange`, the same ruler, so the guide and the flag cannot drift apart.

#### 3.2 The performance roll — why every video sounds different

*Operator direction, 2026-09-03. `src/lib/pipeline/performance.ts`, `src/lib/pipeline/delivery-tags.ts`, prompt `prompts/script.v4.md`.*

Gemini TTS performs **inline delivery tags**: bracketed notes that change how the words after them are spoken, and non-verbal sounds it makes on its own — `[giggles]`, `[sighs]`, `[gasp]`, `[sarcastically]`, `[very fast]`, `[whispers]`, `[like a radio DJ]`. The channel's whole appeal rests on the host sounding like a person rather than a narrator, and that is what these buy.

- **The roll happens outside the model.** Told to "vary the tone", a model varies it across the space *that model* finds natural, which is far smaller than the space the product wants. `rollPerformance(traceId)` chooses the format, the tone and pace at each phase, which non-verbal sounds are in play, roughly how many, and the comedic device — from a seeded PRNG, so a run is reproducible from the audit package alone. Same reasoning as the host's fixed action cycle (§7.5): where there is no genuine ambiguity, spend determinism rather than tokens.
- **The energy shape is not rolled.** Hook hard → warm through the middle → soften at the close, on every video. It is a retention strategy, not a preference: the opening has about two seconds to survive a thumb, and an ending that lands quiet is what makes the closing question feel like a question. The die chooses each phase's *flavour*, never whether the phase exists.
- **Laughter is always in the set**, by operator direction — a sigh or a gasp is punctuation, a laugh is what makes a listener believe there is a person there. A character voice (`[like a deadpan sports commentator]`) is rolled about one video in four, because it is delightful once and a bit for the whole channel if it arrives every time.
- **Comedy is required and bounded.** Every script must land one joke or old saying, delivered `[sarcastically]`. Rule 10 of the prompt says why it is one or two moments and not a register: a script that is sarcastic throughout reads as contempt for the subject.

**The safety property, and where it actually lives.** One script becomes two strings. Gemini gets the tags, because it is the only consumer that understands them. *Everything else* gets the words alone — Edge TTS, which would speak the word "giggles"; `scripts.body`, which is the near-duplicate corpus and the export package's script; ALIGN, which matches Whisper's transcript against it; and above all the burned-in caption track, which cannot be taken back. That guarantee is subtractive and lives in `stripTags` (`delivery-tags.ts`), applied on the way *out* to every clean consumer — never in trusting the writer to place tags correctly. An invented `[whispering conspiratorially]` costs a delivery note; it never costs a caption reading "whispering conspiratorially". Validation is correspondingly permissive about content and strict about shape: Gemini reads these as free-form prose, so an exact allowlist would cap the product's range at whatever list was typed into the file. The fence is ≤8 words and ≤60 characters with no sentence punctuation — words rather than characters, because "she gestures broadly at the entire concept of patch notes" is 57 characters and 10 words, and the vocabulary's own longest legitimate entry is exactly 8.
- **`beatWordRanges` counts spoken words only.** A beat opening `[giggles] Nobody reads...` speaks four words and contains five tokens, and those ranges index straight into the sequence ALIGN matched against the audio. Counting the tag would shift that beat's boundary and every boundary after it, and the footage would cut a word late for the rest of the video.
- **Most videos will not hear them.** The tags mean nothing on Edge TTS, and Gemini's free tier is ten requests a Pacific day (§3). `audit_json.performance.deliveryApplied` records whether the roll actually reached a voice that performs it, and AUDIT SUMMARY flags the video when it did not — a reviewer reading `[giggles]` in the script has to know whether they should be able to hear it.
- `scripts.beats` holds the beats as written, tags and all; `scripts.body` holds the stripped narration, so AUDIT SUMMARY's near-duplicate check, the export package and the console's review queue read a script without knowing what a beat or a tag is. Both columns stay nullable for rows written before the format landed.
- **The v1 prose path is gone** (deleted 2026-09-03). `generateScript`, `ScriptResponseSchema`, `prompts/script.v1.md`, `prompts/script.v2.md` and `schemas/script.schema.json` were retained "for callers that predate the format" and no caller ever did.
- `prompts/script.v4.md` receives the signal's title/summary, **the RESEARCH brief** and **the performance block** — and nothing else. Same hallucination boundary as ever: rule 6 tells the writer the research block is everything it knows, and that an angle is its to invent while a fact is not. A null brief renders as an explicit "no research was available" line, never as a blank section.
- Which signal gets scripted next weights `directives.compiled_json.preferred_source_ids` (favor signals from those sources) and, when `diversity_mode` is on, actively spreads the day's 3 picks across different `sources.id` values rather than always taking the single highest-`engagement_score` signal — queries today's already-`scripted` signals (via `scripts.created_at`) to know what's already been picked today.

### 4. CRITIC (Groq, second pass, adversarial, doesn't see the drafting prompt)
- Scores `originality_score` 0–1: does this script take a genuine angle, or does it just recite the signal back with narrator filler?
- Flags anything resembling defamation of a named real person, medical/legal claims stated as fact, or content that reads as a verbatim repost of the source discussion.
- **Advisory only** — and, since 2026-09-03, actually implemented that way. A low score or a flag does not stop the script from proceeding, and neither does a critic that cannot be reached: `render.ts` marks the stage `degraded`, calls `markCritiquedWithoutVerdict` so the signal still leaves `scripted` (`critiqued -> exported` is the only legal edge into EXPORT), and exports with `critic: null` and AUDIT SUMMARY's "no originality score" flag. Until then RENDER threw on a CRITIC driver error, and a run with a finished script and a finished RESEARCH brief was thrown away by `CRITIC failed: HTTP 429` — for want of a second opinion nothing was waiting on. The score is left null rather than defaulted: it is the one number in the package a reviewer weighs against the script itself, and a placeholder would read as a real verdict.

### 4.5. PLAN (Groq `gpt-oss-120b`) — what the audience sees
*Added 2026-09-01 by operator direction. `src/lib/pipeline/shot-plan.ts`, prompt `prompts/shot-plan.v2.md`. It also chose the host's action per shot between 2026-09-01 and 2026-09-03; the host is deterministic now (§7.5) and PLAN chooses nothing about it.*

- Turns the script into an ordered shot list: `{ beatIndex, intent, query, source: "youtube" | "pexels" }`, one shot per beat plus an opening image over the hook, capped at 8.
- **Why a model here when `keywords.ts` is deliberately not one.** The first stock montage searched for the frequency-ranked keywords of a script about moral collapse and got `maybe`, `yet` and `perhaps` — three of eight shots illustrated nothing. "Which phrase in this beat is a *picture*" is not a counting problem. This is the one footage decision with real ambiguity, so it is the one that spends a token.
- **Deterministic validation after it.** `isFilmableQuery` rejects a single-word query and one that is abstract all the way through once articles and prepositions are stripped. Rejected shots are dropped, never repaired — a query invented to patch a hole would be exactly the filler this stage exists to stop.
- **Never fatal.** A failed PLAN falls back to `extractKeywords`, marked `origin: "heuristic"` with the reason, exactly as §2.5 lets RESEARCH fail. The fallback gets the same filmability filter, so it cannot reintroduce `maybe`.
- **`viral` never reaches the model.** Its background is always a GTA 6 walkthrough (operator direction), and once the topic has decided the footage there is nothing left to decide. It short-circuits and spends nothing.

### 5. SOURCE (formerly FOOTAGE SELECT)
*Rewritten 2026-09-01. `src/lib/footage/source-agent.ts`. The maintained-library claim path (`claimNextFootageSegment`) is no longer used by RENDER.*

- Executes the plan. **Pexels** answers "an ordinary scene, shot well" — the returned clip is already the whole shot. **YouTube** answers "the actual thing", and a YouTube result is an hour of video with one usable minute in it, so the window is chosen by motion scoring rather than taken from the front, which is where a channel puts its intro.
- **Sourcing is open.** `ChannelTopVideoRequest.query` searches YouTube freely; the maintained-channel rule (migration 0008) binds only the weekly FOOTAGE REFRESH, whose cron was removed the same day. Operator decision, recorded because it is a real change to the footage policy.
- **`viral` cuts at random** from the top motion-scored shortlist after a head/tail buffer — operator's words, "clipped from random locations with buffers at the beginning and end". Everything else takes the highest-scoring windows outright, because a shot chosen to illustrate a beat should be the best moment available, not a random one.
- **The YouTube download cap is topic-aware** (operator direction, 2026-09-01): **4** for `politics`, `tech`, `science` and `ai`; **2** for everything else. Each download is potentially a gigabyte through a converter site on the operator's own connection, so this stays a hard cap rather than a preference — but on those four topics the real recorded event exists and stock has no clip of it, and two real clips across an eight-shot montage means the montage is mostly stock. The trade is roughly one extra download cycle, the slowest part of the pipeline. `viral` is unaffected: it downloads one source and cuts many windows from it. A shot past the cap falls back to Pexels and the reason is reported. A cache hit does not spend a slot — it costs no bandwidth, so counting it would refuse footage already on disk.
- **Nothing is retained.** Clip bytes live in the render's work directory and die with it; provenance rows are dropped when the export retires (§9). The one exception is the 24h YouTube *source* cache (`.footage-cache/`, `src/lib/footage/source-cache.ts`), which exists solely so a viral run does not re-pull 1.6 GB hourly. No clip and no Pexels byte is written there.
- **Provenance is now the only record.** Since no bytes survive, every clip's `footage_segments` row — provider, source video, exact window, and the query that found it — is written *before* the clip reaches the encoder, and `render_footage_parts` records which second of the finished video it occupies.
- Shot status (`planned → searching → downloading → clipped → composited | failed`) is written to `shot_plans` as each thing actually happens, which is what stage 5 displays.

### 5.5. EDIT (Groq `gpt-oss-120b` + Kinocut over MCP)
*Added 2026-09-01 by operator direction. `src/lib/pipeline/edit.ts`, `src/lib/drivers/mcp-stdio.ts`.*

Runs between SOURCE and RENDER — strictly, after the montage timeline exists, because a clip's edit depends on how long it will be on screen and that is not known until the narration is timed. For each clip, the model probes it, detects its scenes, trims to the window worth showing, and optionally applies one subtle grade.

- **It edits clips; it does not make videos.** No stitching, no host compositing, no captions, no final encode — those stay in `render-ffmpeg.ts`, which is the path the operator has verified end to end. Putting a model-driven tool loop on the critical path of the final encode would trade a working pipeline for a more capable one that sometimes produces nothing.
- **It fails soft at two levels.** A clip whose edit fails keeps its sourced bytes and stays in the montage; a stage that cannot start at all (no `uvx`, no Kinocut, a rate-limited model) returns every clip untouched. Either way the render continues and produces exactly the video it would have produced before this stage existed, and the reason reaches the audit package. This is the same contract §5.2.5 gives RESEARCH, and it is the only contract under which adding a stage to a working pipeline is safe.
- **Only ~9 of Kinocut's 196 tools are offered** (`EDIT_TOOLS`). A tool loop re-sends every schema on every turn, so the full surface would spend a large share of the 200K-token daily budget on the menu before the model looked at a frame. The allowlist is enforced on the *call*, not merely by what was offered.
- **Schemas are fetched, never hard-coded.** `tools/list` at run time, filtered by name — a pasted schema silently drifts from the server on its next release, and the failure would be a model confidently passing an argument that no longer exists.
- **The model's output path is checked to exist** before the encoder is told to read it. A hallucinated path would otherwise fail the whole render at encode time, long after the stage that invented it.
- Kinocut is local-first, Apache-2.0, and needs no key or account; it wraps FFmpeg and Whisper on the same machine. The MCP client is ~150 lines of newline-delimited JSON-RPC rather than `@modelcontextprotocol/sdk`, for the same reason retrieval is not a framework (§5.2.5): three methods are used, over one transport, against one server.

### 6. TTS + CAPTION SYNC (Edge TTS by default, Gemini TTS as the upgrade)
- `src/lib/drivers/tts-edge.ts` shells out to `scripts/edge_tts_synth.py`, a thin wrapper around the `edge_tts` Python library requesting `WordBoundary` events explicitly (the bare `edge-tts` CLI hard-codes sentence-level boundaries and has no flag to change that — confirmed by testing it directly, not assumed). Returns audio bytes plus one `{word, startMs, endMs}` entry per word — no separate forced-alignment step needed.
- Word timings become `captionCues` for RENDER: rendered as bold, high-contrast text that fades word-group to word-group, matching the reference style.
- Voice is picked from `directives.compiled_json.voice_pool` (or the full default curated pool in `src/config/voices.ts` when unset) — when `diversity_mode` is on, excluding voices already used by today's earlier renders. `rate`/`pitch` come from the directive's fixed value if set, otherwise randomized within `tts_rate_range` per render. The actual voice used is recorded on `renders.tts_voice`, both for the audit package and for tomorrow's diversity query.
- **Gemini single-speaker TTS is the expressive upgrade, never the default** (`src/lib/drivers/tts-gemini.ts`, added 2026-08-31 on operator instruction). One request per video, forced by the free tier's **10 requests per day** — per-beat synthesis would cost one request per beat, so a 20-beat video would be twice the entire daily budget. `src/lib/pipeline/tts-select.ts` offers it while fewer than 8 of today's renders have used it, holding 2 back so an operator re-run still gets the same voice.
- Per-beat expressiveness therefore travels *inside* that one request, as bracketed inline direction derived from each beat's `move` (`src/lib/pipeline/tts-direction.ts`). **Whether inline direction actually shifts delivery mid-utterance is unmeasured** (plan v2 §9), which is why `directives.compiled_json.per_beat_delivery` defaults to **off** — the measured-safe path is one flat style for the whole script.
- A Gemini failure falls back to Edge and the render continues; the reason is logged and written into the audit package (`audit_json.narration.fallback_reason`), never silent. Edge failing is a real failure — there is nothing below it.

### 6.5. ALIGN (Groq Whisper, word granularity — Gemini path only)
- **Gemini TTS returns audio and no timings, and that is the single most important technical fact in the v2 format.** The word-level captions this system is built around came entirely from Edge's `WordBoundary` events, so switching narration providers naively would delete the caption feature the change was meant to enhance.
- `src/lib/drivers/groq-whisper.ts` force-aligns the audio with `timestamp_granularities[]=word` (it requests `segment` alongside, because asking for `word` alone makes the provider drop the segments existing transcript callers read). One request per video, not per beat — a single audio file is all there is to align.
- ALIGN is also the only source of **beat boundaries**: the beat texts are known, so mapping them onto the returned word sequence puts each beat on the clock. The mapping is an LCS alignment (`src/lib/pipeline/align.ts`), not a positional assumption — a transcript that says "gonna" where the script wrote "going to" would otherwise shift every subsequent boundary.
- **Refuses rather than approximates.** Below a 60% word match the alignment is rejected outright: a bad alignment does not look like an error downstream, it looks like a video whose captions drift and whose cuts land mid-word, discovered minutes of render time later.
- **The Edge path skips this stage entirely** — its timings are native and exact, and cost no call.
- **A failure here no longer costs the video** (operator direction 2026-09-01, `src/lib/pipeline/align-stage.ts`). It used to throw, so a complete narration, a complete script and a complete footage montage were discarded because one transcription call failed. The words are now spread across the narration's *measured* duration, weighted by word length, and the audit package carries `narration.captionTiming`: `native` (Edge's own events, exact), `aligned` (this stage, accurate to `alignMatchRatio`), or `estimated` (this stage failed; captions stay in step across the video and drift within a sentence). `estimated` is flagged, because a reviewer cannot tell drifting captions from a bad take without being told which they are watching.

### 7. RENDER (FFmpeg, local to the GitHub Actions runner)
- Crop/scale **every** footage clip to 1080×1920, filling ≥75% of frame height (matches the "transformative" visual treatment the operator specified), then `concat` them into one track. Normalising first is not optional: `concat` requires its inputs to agree on size, pixel format, frame rate and sample aspect, and clips from different photographers agree on none of them.
- **Cuts land on the argument, not on a timer** (`src/lib/pipeline/montage-timeline.ts`): a shot acquired for beat 3 starts on the first word of beat 3 and holds until the next shot's beat begins. A shot that would run under 900ms is dropped and its neighbour holds through it, so every millisecond is covered by exactly one shot.
- **The output length is set explicitly**, from the narration's measured duration. `-shortest` alone does not settle it once the footage track has a definite end — a 12.0s narration produced a 13.5s render. A single looped clip never hit this, because nothing in that graph ever ended. The host overlay pass (§7.5) carries the same fix for the same reason.
- Mute the source clips' original audio entirely; mix in the narration track.
- Burn in captions via an ASS subtitle file (word-timed fade, not a static SRT box) using FFmpeg's `ass` filter. Each cue is emitted one event per word so the spoken word is accented as it lands, and keywords (`src/lib/pipeline/keywords.ts`, no model call) stay accented for the cue's whole life.
- **The host is not in this pass at all** (operator direction, 2026-09-03). RENDER produces a complete, publishable Short — footage, narration, burned-in captions — and the character is composited over that by its own ffmpeg pass. See §7.5.
- Loop or trim the footage segment to the narration's exact duration.
- Headless export to MP4, `dist/render/<script_id>.mp4`, deleted only after a confirmed EXPORT write (§9).

### 7.5. HOST (FFmpeg, a second pass — no model call)
*Operator direction, 2026-09-03. `src/lib/pipeline/character-timeline.ts` decides the performance; `src/lib/drivers/character-overlay-ffmpeg.ts` encodes it.*

- **The performance is fixed.** The host waves hello, runs the pack's other 17 actions once through in `manifest.json` order, loops that 50.5-second cycle for as long as the video lasts, and waves goodbye. The only rule is that the first and last actions are the waves. Nothing chooses; the inputs are the pack and a duration. Re-ordering the performance means editing the pack's JSON, with no code involved.
- **What that replaced.** From 2026-09-01, PLAN picked an action per shot from the manifest's `use_when` text and `character-timeline.ts` re-checked those picks against the pack's `agent_selection_rules`, correcting a mid-video sign-off, two chained reactions, or an invented id. That bought gestures that tracked the argument; it cost a model call whose output had to be validated, a per-shot correction log in every audit package, and a class of defect only findable by watching. A fixed cycle cannot be wrong and costs nothing.
- **Two accepted consequences.** The host cuts on its own 12fps cadence rather than on the footage's, so the two drift past each other; and the pack's silent actions (idle, nod, shrug, thinking) play under continuous narration. Both follow directly from "every animation in sequence".
- **Why a separate pass rather than four more inputs in §7's filtergraph.** Three reasons, in order of weight. *It cannot fail the video*: a missing pack, an unreadable manifest or an encoder error leaves §7's output — already a complete Short — exported with `characterAbsentReason` set, the same contract §5.2.5 gives RESEARCH. *Input count*: a 128-second video is ~44 actions, which as `-i` arguments is 44 concurrent decodes of lossless RGBA on the operator's own machine; through ffmpeg's **concat demuxer** it is one input. *It is what the stage is*: the host goes on top of a finished video, and a separate pass says so instead of implying it through filter ordering.
- **The concat demuxer works because the pack is uniform.** Every one of the 19 MOVs is `png / 640x680 / rgba / 12fps` (verified with ffprobe, 2026-09-03), and PNG is all-intra — so the single `outpoint` trim in a track, the partial action that lands the goodbye wave on the end, is frame-exact rather than snapped to a keyframe.
- **The track overshoots, never undershoots.** It is built to run past the video's end and the pass cuts it with an explicit `-t`. An overshoot costs the goodbye wave up to 0.8s of its 3.0s tail and still reads as a wave; an undershoot would leave the final fraction of a second with no presenter, which reads as a crash. No action is ever shorter than 0.8s (ten frames at the pack's rate), so nothing flashes.
- **There is no chroma key anywhere in this system.** The original host was a GIF on a flat `#e5505c` field whose key sat one channel from her own face — `0.14 began eating her face and 0.20 destroyed it`. The pack's MOVs carry a real 8-bit alpha channel, so the key, its tolerance window, and the hand-counted frame holds that stretched that GIF are all gone. `yuva420p` (not `yuv420p`) is what carries the alpha into `overlay`; dropping the `a` flattens the host onto a black rectangle **and still encodes successfully**, which makes it the one mistake here worth naming.
- **The host sits on top of the burned-in captions, and that is safe rather than lucky.** The captions are ASS `Alignment: 5`, so they sit at the vertical middle of the frame; the host occupies 10%–44% of the height measured from the bottom. They do not meet. Moving either one is a change that has to be checked against the other.
- **Audio is stream-copied.** The narration is already AAC from §7, so this second encode costs the picture one generation and the narration nothing.

### 8. AUDIT SUMMARY (deterministic — no model call). See §9 for full detail. Never blocks — informs the human reviewer.

### 9. EXPORT (Cloudflare KV, via `ExportDriver`)
- LLM-generated suggested title/description/hashtags, schema-validated (`src/lib/pipeline/upload-metadata.ts`) — suggestions for the operator's manual upload, not submitted anywhere, and read in stage 6's Metadata sheet. **Never fatal**: a failed or malformed listing degrades to one derived from the script — a whole-sentence title, a description that ends where a sentence ends, and hashtags from `extractKeywords` — and the reason is recorded. This stage was described here from the beginning and did not exist until 2026-09-02; RENDER passed `hook.slice(0, 100)`, `body.slice(0, 500)` and an empty tag list, so every export until then had a description that stopped mid-word and no hashtags.
- Assembles `audit_json`: the script, the CRITIC verdict (or `null` when the critic could not be reached — §5.4), footage provenance (segment id, source video id/channel, clip range, and per clip **both** the span of the finished video it occupies *and* the span of the source it was cut from — `startMs`/`endMs` and `sourceStartS`/`sourceEndS`, which answer different questions and neither of which can be derived from the other), the TTS settings actually used — **which driver actually spoke, the voice, the rate, the inline style direction sent, why the narration was downgraded if it was, and ALIGN's word-match ratio** (`audit_json.narration`) — which pack the host came from, its version and the exact sequence of actions it performed (or `characterAbsentReason` when the pack was missing or the overlay pass failed, §7.5), and the AUDIT SUMMARY result.
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
| `POST /console/dispatch` | trigger a pipeline run ad hoc: records a `runs` row, then starts `render.yml` via `workflow_dispatch` with that row's id as `trace_id` and the queued pick count as `count` (`src/lib/drivers/github-actions.ts`). With no `GITHUB_DISPATCH_TOKEN` it records and reports `not_triggered` rather than pretending | session + rate limited to 10/hour |
| `POST /console/scripts/:id/approve` | approve a `pending_approval` script | session |
| `GET /console/exports` | list export packages, filterable by status | session |
| `GET /console/exports/previews` | Pexels **preview** stills for every live export's script keywords — stage 6's sneak peeks. Shares `/runs/:traceId/montage`'s per-keyword day-long KV cache. Never footage for the render | session |
| `GET /console/exports/:id/metadata` | the upload sheet for one finished video, read out of `audit_json`: suggested title, description, hashtags, and every clip with its provider, the source it came from, **the span of that source it used**, and a link that opens the source at that second. Answers "did this run use any YouTube footage, and which" — the one §9 fact the product recorded and never displayed | session |
| `GET /console/exports/:id/download` | stream the rendered MP4 from R2 (or from KV for rows written before 2026-08-31 — the storage key says which) as a `Content-Disposition: attachment`, and move a `ready_for_review` row to `downloaded` | session |
| `GET /console/exports/:id/stream` | the same bytes for stage 6's in-place player: `video/mp4` inline, byte ranges (206) so the scrubber works, and **no status change** — watching a video in the console is not taking possession of it | session |
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
| `GET /console/ideas?topic=&limit=&exclude=` | ranked candidate signals for one topic — BM25 over `signals` plus engagement, **no model call** (`src/server/console/ideas.ts`); the guided run's step 3. Returns a bare array | session |
| `POST /console/ideas/refresh` | re-runs WATCH's ingest and SCORE once per stage entry, polling **one source per host**, rotating to whichever that host left stalest, with 429 retries off (`src/server/console/ideas-refresh.ts`, 2026-09-03). reddit.com serves ~one RSS request per IP per 30-60s, measured; the previous concurrent-with-retries refresh sent up to nine in a burst and every Reddit fetch on entry failed. Never fails the screen — it reports `sourcesFetched`/`degradedReason` | session |
| `POST /console/ideas/refresh` | re-runs WATCH's ingest and SCORE once, for the stage 3 -> stage 4 transition. Sources are fetched concurrently with an 8s ceiling, unlike the scheduled poll (§5.1), because a person is waiting on it. Reports `{sourcesFetched, sourcesFailed, newSignals, degradedReason}` — a feed outage shows as "3 of 5 answered", never as a silently shorter list | session |
| `GET /console/run-plan` / `POST /console/run-plan` | list / queue the operator's picks (`run_picks`); RENDER claims them in order. Queueing never triggers a render | session + schema validation |
| `DELETE /console/run-plan/:id` | cancel a still-queued pick (a claimed one is being rendered, and is not cancellable) | session |
| `GET /console/runs` | recent runs, grouped by `runs.trace_id` | session |
| `GET /console/runs/:traceId` | one run's stages and the videos it produced (`scripts.trace_id` → render → export) | session |
| `GET /console/runs/:traceId/montage` | Pexels **preview** clips for each video's script keywords — cached per keyword in KV for a day. Never footage for the render | session |
| `POST /console/voice/transcribe` | speech-to-text via Groq Whisper for the voice control surface | session |
| `POST /console/voice/turn` | one voice turn — transcript in, tool calls dispatched through `POST /console/mcp`'s exact contract (actor `mcp` in `audit_log`, not `agent`) | session |

No `/api/ask` this time — there's no public content site to chat against. The console is the entire authenticated surface; nothing here causes an anonymous browser to trigger an LLM call, and there is no upload call anywhere in this system to trigger.

Full console design: **`CONSOLE_SPEC.md`**.

---

## 7. Secrets model

| Key | Where you get it | Scope |
|---|---|---|
| `GROQ_API_KEY` | console.groq.com | default. **Not** used by the FOOTAGE REFRESH job — that job has been model-free since 2026-08-29 (§5.0); it is still required by the shared `buildPipelineEnv()` because the daily render pipeline needs it |
| `CLOUDFLARE_API_TOKEN` | dash.cloudflare.com | Workers/KV/D1/Turnstile edit, no `Zone:Edit`. Also what the GitHub Actions render job uses to write export blobs to KV via the REST API (§9) |
| `VAULT_MASTER_KEY` / `SESSION_SIGNING_KEY` | `openssl rand -base64 32` | Worker secret only |
| `TWENTYFIRST_API_KEY` | 21st.dev | dev machine only, never CI/Workers |
| `GEMINI_API_KEY` | aistudio.google.com | Both, and **optional**. Buys the expressive narration upgrade and nothing else — absent, TTS runs on the Edge default path exactly as before it existed. Vault-first, env/Worker-secret fallback, same resolution as `GROQ_API_KEY`. Its live check deliberately calls a *text* model, never the TTS one: a rotation that spent a TTS request would cost 10% of the day's narration budget |
| `PEXELS_API_KEY` | pexels.com/api | Worker only, and **optional**. Buys the run view's preview montage (§6) and nothing else — the pipeline never reads it, and an unset key degrades one screen rather than failing anything. Vault-first, Worker-secret fallback, same resolution as `GROQ_API_KEY` |

Edge TTS needs no key at all — that's the entire appeal and the entire risk (§0).

**Where each key lives** — unchanged shape from MythosEngine: developer machine `.env.local` (gitignored), GitHub Actions Repository Secrets, `wrangler secret put` for the Worker, the console's own KV vault (AES-GCM under `VAULT_MASTER_KEY`) for rotatable provider keys. `CLOUDFLARE_API_TOKEN` stays outside the vault, same reasoning as before: a console that can rewrite its own infrastructure credentials is a privilege-escalation path.

---

## 8. Console frontend

Astro island(s) mounted only on `/console/*`, same `tokens.css` token discipline as before — the wet-slate palette's ground tone moved to true black (`--ink: #000000`, `--slate: #0a0a0c`) on 2026-08-28 specifically so WebGL/canvas elements (the Liquid Metal shader, the Siri Wave) read as native to the page rather than sitting in a visibly separate box. One `@astrojs/react` island (`PromptInputBox.tsx`, `/console/chat` only) is the sole framework exception — everything else, including the radial nav's full-screen/compact states, is plain Astro + vanilla TS. There is no public marketing hero to build here; skip straight to the dashboard. Full spec in `CONSOLE_SPEC.md`.

### The chat/voice agent's turn budget

`/console/chat` and `/console/voice` both run `runAgentTurn`
(`src/server/agent/loop.ts`): up to `MAX_TOOL_ITERATIONS` Groq round trips
against the `AGENT_TOOLS` allowlist, with D1 reads between them. Three
bounds keep one turn from becoming an outage, and all three exist because
the 2026-08-29 incident (§4) tripped every one of them at once:

- **A failing tool runs at most once per turn.** A repeated call signature
  (`name` + exact arguments) is short-circuited with an
  `already_failed_this_turn` result carrying the original error, so the
  model has something to report instead of a retry loop. Without this, a
  broken `get_summary` — ~12 D1 queries a call — exhausted the Worker's
  subrequest budget within three iterations and the request 500'd before any
  assistant message was written. The operator saw the question vanish.
- **The client allows 90s for an agent turn**, not the 10s every other
  mutation gets (`src/console/lib/api.ts`). A turn that needed even one tool
  call was being aborted browser-side and reported as an unreachable API.
- **A turn in flight is visible.** The thread renders an animated indicator
  until the turn resolves, and a failed turn says so inline rather than only
  raising the top-of-page banner. "Slow" and "dropped" must not look alike.

The system prompt also states the model's own identity (`openai/gpt-oss-120b`,
served by Groq) — asked unprompted, it otherwise claimed to be GPT-4.

---

## 9. AUDIT SUMMARY — informing the human, not replacing them

**Nothing in this system uploads automatically, ever** — the operator reviews and uploads every video by hand, in YouTube Studio, under their own judgment. The operator is the actual gate.

AUDIT SUMMARY exists so that judgment call is fast and well-informed instead of blind. It runs the same checks the old GATE did, computed deterministically (no model call) on every render, stored on `renders.audit_result` and folded into the export's `audit_json` (§5.9) — but it **never blocks progression**. Every render reaches EXPORT regardless of its result; a failing check is a prominent flag in the review package, not a rejection.

Checks:

- JSON Schema validation on the script and the suggested upload metadata (Zod).
- `originality_score` (from the CRITIC stage) vs. the active directive's `min_originality_score` — reported as pass/fail, not enforced.
- Word count, hook length, and debate-question presence within bounds.
- The footage segment came from `footage_segments` (library-only, §1 NEVER of `CLAUDE.md`) — this one *is* structurally enforced earlier, at FOOTAGE SELECT/RENDER, not here; AUDIT SUMMARY just echoes the provenance for the reviewer.
- Rotation health: how recently `footage_segment_id`/`renders.tts_voice` were last used (variety signal, not a rule).
- Similarity to the last 100 scripts < 0.85 (self-repetition / templating check — flagged, not blocked).
- A reminder that the synthetic-media disclosure (`status.containsSyntheticMedia`, confirmed against Google's current Data API v3 docs) should be set when the operator uploads manually.
- Caption/audio duration match within tolerance (flagged if a render's captions run past the narration audio).
- **Which provider and model actually answered each reasoning stage**, and why it was not the preferred one — RESEARCH, SCRIPT and PLAN each record `provider`, `model` and `fallbackReason`. Since 2026-09-02 this genuinely varies between exports rather than repeating itself: RESEARCH tries Gemini first and falls back to Groq on any failure (§5.2.5), so two videos rendered an hour apart can carry briefs from different providers built from different amounts of source text. `fallbackReason` is what makes that legible rather than merely visible — a reviewer reading `groq` with no reason cannot tell a deliberate configuration from a quota failure. "Which model wrote this" is the first thing a reviewer asks about a script that reads oddly.
- **What EDIT (§5.5.5) did to each clip** — which Kinocut tools ran, whether the clip changed, and why it was left alone if it was not. A clip trimmed to a different moment than the one SOURCE chose is a clip whose footage-provenance window is no longer the whole story, so the two are read together.
- **Which of the host's actions played over each shot**, and every correction the character timeline had to make to PLAN's choices. Watching the video tells a reviewer the host shrugged over beat four; only this tells them whether PLAN chose that or whether an invented action id was substituted.
- **The RESEARCH brief (§5.2.5) the script was written from** — its summary, the model that produced it, the tools it actually ran, and every citation with the source's title and URL. A render whose research failed carries `ungrounded: true` and a flag saying the script was written from the signal title alone. This is informational, like everything else here, but it is the piece that changes how much weight a reviewer should give the script's specifics: a grounded script's claims can be checked against the cited sources, and an ungrounded one's cannot.

Every signal computed here is visible in the console's review queue (`CONSOLE_SPEC.md` §4) before the operator downloads or discards an export.

---

## 10. Quota & cost budget

Assume 3 exports/day as the ordinary case, 6 as the ceiling — the count is
the operator's, chosen per run in the console's guided sequence, not a cron's.
RENDER lost its 3x/day schedule on 2026-08-31: footage only reaches the
library from the operator's own machine (§5.0), so a scheduled render could
not assume the machine it depends on was even awake. Every render is now
dispatched (`.github/workflows/render.yml`), which also means the budget below
is a ceiling the operator can choose not to spend rather than a floor the
system spends on its own.

| Resource | Per-day consumption | Free ceiling | Headroom |
|---|---|---|---|
| Groq requests | ~24 score-passes + 3 research turns × up to 6 iterations + 3 scripts + 3 critics + 3 metadata-gens ≈ 51/day. **Browsing stage 4 costs nothing** — its reranker was deleted 2026-09-03 and the Worker makes no model call at all. RESEARCH usually costs Groq nothing either: it tries Gemini first (§5.2.5). FOOTAGE REFRESH contributes nothing — it makes no model calls (§5.0). The binding constraint is tokens-per-day on `gpt-oss-120b`, not requests: EDIT alone is ~90-110K of it per render | ~14,400/day | requests huge; 120b tokens are the real ceiling at ~2 renders/day |
| GitHub Actions minutes | hourly WATCH × 24 (~1 min each) + up to 6 dispatched render jobs × ~5 min (FFmpeg is the expensive part) + weekly footage job (~15–20 min — a headless Chromium launch per candidate adds a little over the old yt-dlp job) ≈ ~55 min/day amortized at the ceiling | 2,000 min/mo private | fine — public repo removes the ceiling entirely, and RENDER runs on the self-hosted runner, which bills no minutes at all |
| KV writes | batch manifest + rate-limit counters + 3 export blobs ≈ well under 50 | 1,000/day | fine |
| KV storage | 3 exports/day × 3-day TTL ≈ ~9 exports resident at once × (MP4 size, TBD — see §3's `ExportDriver` note) | 1GB total | needs the real render-size check before this is a settled "fine," not before |
| Edge TTS | 3 × ~150 words ≈ 450 words/day | no formal quota — it's not a real product | **the actual risk isn't quota, it's the endpoint disappearing.** Alert loudly on TTS driver failure, don't silently fall back to a paid provider without telling the operator |

RESEARCH is the one stage whose *token* cost grows with how hard it works: up to 6 iterations, each re-sending the whole conversation plus ~500 tokens of tool schemas, plus up to 6,000 characters per source read. Budgeted at roughly 15–25K tokens per render, ~75K/day for three. It ran on `gpt-oss-20b` from 2026-08-30 until 2026-09-01 precisely so it would not eat the 120b budget CRITIC needs; operator direction ended that split, so it now shares the one 200K/day with every other stage. Three renders a day fit inside it. A day of re-runs might not, and the symptom would be a late render failing at SCRIPT rather than anything named "quota" — if it ever threatens the ceiling, the levers are `maxIterations` and `article-fetch.ts`'s `maxChars`, in that order.

The two real constraints, updated from before: **KV's per-value and total storage caps** (settled once Phase 6 measures a real rendered file against them, per the open item in §3) and **Edge TTS's unofficial status** (this is a reliability risk, not a cost one — budget for it with retries and a loud alert, not with money). YouTube API quota is no longer tracked at all — there's no YouTube API key left in the system (§5.0, §7).

---

## 11. Failure modes this design closes

| Domain | Closed by |
|---|---|
| Publishing control | no automated publish path exists at all — the operator manually reviews and uploads every video; AUDIT SUMMARY (§9) still surfaces every signal the old GATE checked, so that review is fast, not blind |
| Network dependency | footage acquisition isolated to one weekly, low-volume, fully-audited job; daily render never touches the network for footage |
| Architecture | driver interfaces; repo-as-source-of-truth for the footage library; one shared schema between pipeline and console |
| Security | no client keys; no YouTube OAuth credential anywhere in the system (§7) — only a read-only API key for footage search; Turnstile + rate limit on any public route; gitleaks in history + bundle scan |
| Data integrity | natural-key UNIQUE = idempotency; CHECK constraints; state machine with single-step transitions |
| Reliability | `Result<>` instead of exceptions; per-stage timeouts; backoff + jitter; a `failed` state with `attempts` as the DLQ |
| Observability | `runs` + `audit_log`; alert on Edge TTS failure rate, KV export-write failures, or 3 consecutive stage failures |
| Maintainability | strict TS, no `any`, no `@ts-ignore`; `knip` in CI |
| Ownership | Operator steering via CLI — future direct prompts in CLI should be prioritized due to changing user needs |
