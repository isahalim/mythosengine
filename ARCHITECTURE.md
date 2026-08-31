# Mythos Engine — System Architecture

**Version:** 2.0 — pivot from MythosEngine (game-news publishing) to an autonomous YouTube Shorts pipeline. Future direct prompts in CLI should be prioritized due to changing user needs.
**Owner:** single operator (you). One human account, passkey-authenticated. No public sign-ups.
**Prime directive, carried over:** prefer a permanent, card-free free tier wherever one exists. It doesn't exist everywhere here — video generation has real costs the old text-only project didn't. Where it costs money, the cost is small, bounded, and stated plainly (§10), never hidden.

---

## 0. The stack, and what it costs

| Service | Permanent free? | Card-free? | Role |
|---|---|---|---|
| **Groq Cloud** (`openai/gpt-oss-120b` / `openai/gpt-oss-20b`) | Yes — rate-limited, no credit system. ~30 req/min, ~8k tokens/min, ~14.4k req/day, enforced per organization. **Limits are per-model, and the one that binds is tokens-per-day:** 200K for gpt-oss | **Yes** | Script generation, critique, title/description/hashtag generation, the RESEARCH agent's tool-calling loop (§5.2.5, on the 20b model — per-model quotas mean the cheaper model's budget is a separate 200K), and the console chat/voice agent. **Not footage acquisition** — that ran a browser agent on `qwen/qwen3.8-27b` (2M TPD) until 2026-08-29 and now makes no model calls at all (§5.0), so the whole gpt-oss daily budget belongs to the render pipeline again. Groq deprecated `llama-3.3-70b-versatile`/`llama-3.1-8b-instant` on 2026-06-17; the OpenAI open-weight models replaced them everywhere in `src/**` |
| **Microsoft Edge "Read Aloud" TTS**, via the `edge_tts` Python library (LGPL-3.0, `rany2/edge-tts`), invoked as a subprocess | Yes, but **not an official product** — no SLA, can break without notice | **Yes** | Narration voice synthesis + word-level timestamps for captions |
| **Cloudflare Workers static assets** | Yes | **Yes** | Hosts the operator console and its API |
| **Cloudflare D1** | 5 GB, 5M row-reads/day | **Yes** | Pipeline state, scripts, footage/segment/render/upload records, audit log |
| **Cloudflare KV** | 1 GB, 100k reads/day, **1k writes/day** | **Yes** | Hot manifests, rate-limit counters, encrypted key vault |
| **Cloudflare Turnstile** | Yes | **Yes** | Bot protection on any public POST route |
| **GitHub Actions** | 2,000 min/mo private, unlimited public | **Yes** | Weekly footage refresh, daily render pipeline, scheduler. FFmpeg and headless Chromium (Playwright) both run here — Workers cannot execute native binaries, launch a browser, or sustain multi-minute CPU jobs |
| **GitHub repo (orphan branch)** | Yes, subject to repo size sanity | **Yes** | The footage clip library. Not R2 — R2's free tier requires a card to activate at all; a rotating library of short trimmed clips fits comfortably in a git branch |
| **Reddit RSS/Atom syndication feeds, News RSS** | Yes | **Yes** | Zero-key trend sources — **not** Reddit's JSON/Data API, see §5.1 |
| **X (Twitter) API** | **No** — the free tier has no meaningful search access as of 2026 | N/A | Not in the default profile. Driver exists, disabled unless the operator has a paid tier |
| **YouTube Community tab** | No official API | **Yes**, but unofficial/fragile | Best-effort source, same fragility contract as `yt-captions` had in the old project |
| **Browser-driven footage acquisition** (headless Chromium, no model) | Yes | **Yes** | Weekly footage-source discovery *and* download (§5.0): Playwright searches youtube.com for `"<game name>" walkthrough "<channel name>" youtube` and reads the results off the page, then convert+downloads the chosen video at **1080p** via `https://media.ytmp3.gg/tools/youtube-to-mp4-converter/dbismy` (ytmp3) by driving that page's ids and polling its own ready/error state. One active channel (@HollowPoiint), whose ~1h episodes are what make 1080p affordable. Replaces the YouTube Data API v3 search and yt-dlp — both removed. No API key, no cookies, no tokens |

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
  ttlSeconds: number; // 3 days by default — see §9
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

**Browser-driven video acquisition** — built, not proposed. A real headless
Chromium (`src/lib/drivers/browser-session.ts`) replaces the YouTube Data
API v3 search and `yt-dlp` — both removed, along with `YOUTUBE_API_KEY` and
`YOUTUBE_COOKIES`. The prior `yt-dlp` driver's last several commits were all
fighting YouTube's bot-check with no durable fix; this replaces the
mechanism rather than patching it further.

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

### 2.5. RESEARCH (Groq, `openai/gpt-oss-20b`, tool-calling — RAG)

Added 2026-08-30 by operator directive. Between SCORE and SCRIPT, the picked
signal becomes a **grounded brief**: what is actually being said about the
topic, and which retrieved source supports each claim.

**Shape.** Groq's own tool-calling is the reasoning core; the RAG pipeline is
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
- Structured JSON output only, `schemas/script.schema.json`. Fields: `hook` (≤3s read-aloud), `body`, `debate_question`, target 130–170 words total.
- `prompts/script.v2.md` receives the signal's title/summary **and the RESEARCH brief** — and nothing else. That is the same hallucination boundary v1 drew, just around a larger set of *retrieved, cited* facts instead of around the title alone: rule 3 tells the writer the research block is everything it knows, and that an angle is its to invent while a fact is not. A null brief renders as an explicit "no research was available" line, never as a blank section — a blank one reads to a model like an oversight to fill in from memory, which is the exact failure RESEARCH exists to prevent.
- Which signal gets scripted next weights `directives.compiled_json.preferred_source_ids` (favor signals from those sources) and, when `diversity_mode` is on, actively spreads the day's 3 picks across different `sources.id` values rather than always taking the single highest-`engagement_score` signal — queries today's already-`scripted` signals (via `scripts.created_at`) to know what's already been picked today.

### 4. CRITIC (Groq, second pass, adversarial, doesn't see the drafting prompt)
- Scores `originality_score` 0–1: does this script take a genuine angle, or does it just recite the signal back with narrator filler?
- Flags anything resembling defamation of a named real person, medical/legal claims stated as fact, or content that reads as a verbatim repost of the source discussion.
- **Advisory only.** A low score or a flag does not stop the script from proceeding — it's carried forward into the AUDIT SUMMARY (§9) and surfaced prominently to the human reviewer.

### 5. FOOTAGE SELECT
- Picks a `footage_segments` row matching the directive's focus game(s), weighted away from recently-`last_used_at` segments. Increments `used_count`.
- **Only from an enabled `footage_sources` row** (§4). A retired channel's segments stay in the library and keep backing the exports that already used them, but are never claimed again — and the console's footage-health count excludes them for the same reason, since inventory nothing can claim is not inventory.
- When `diversity_mode` is on, the game itself is chosen first: exclude games already used by today's earlier renders (via `renders.created_at`) before calling `claimNextFootageSegment` — so a day's 3 videos default to 3 different games rather than 3 different clips of the same game.

### 6. TTS + CAPTION SYNC (Edge TTS)
- `src/lib/drivers/tts-edge.ts` shells out to `scripts/edge_tts_synth.py`, a thin wrapper around the `edge_tts` Python library requesting `WordBoundary` events explicitly (the bare `edge-tts` CLI hard-codes sentence-level boundaries and has no flag to change that — confirmed by testing it directly, not assumed). Returns audio bytes plus one `{word, startMs, endMs}` entry per word — no separate forced-alignment step needed.
- Word timings become `captionCues` for RENDER: rendered as bold, high-contrast text that fades word-group to word-group, matching the reference style.
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
| `GROQ_API_KEY` | console.groq.com | default. **Not** used by the FOOTAGE REFRESH job — that job has been model-free since 2026-08-29 (§5.0); it is still required by the shared `buildPipelineEnv()` because the daily render pipeline needs it |
| `CLOUDFLARE_API_TOKEN` | dash.cloudflare.com | Workers/KV/D1/Turnstile edit, no `Zone:Edit`. Also what the GitHub Actions render job uses to write export blobs to KV via the REST API (§9) |
| `VAULT_MASTER_KEY` / `SESSION_SIGNING_KEY` | `openssl rand -base64 32` | Worker secret only |
| `TWENTYFIRST_API_KEY` | 21st.dev | dev machine only, never CI/Workers |

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
- **The RESEARCH brief (§5.2.5) the script was written from** — its summary, the model that produced it, the tools it actually ran, and every citation with the source's title and URL. A render whose research failed carries `ungrounded: true` and a flag saying the script was written from the signal title alone. This is informational, like everything else here, but it is the piece that changes how much weight a reviewer should give the script's specifics: a grounded script's claims can be checked against the cited sources, and an ungrounded one's cannot.

Every signal computed here is visible in the console's review queue (`CONSOLE_SPEC.md` §4) before the operator downloads or discards an export.

---

## 10. Quota & cost budget

Assume 3 exports/day.

| Resource | Per-day consumption | Free ceiling | Headroom |
|---|---|---|---|
| Groq requests | ~24 score-passes + 3 research turns × up to 6 iterations + 3 scripts + 3 critics + 3 metadata-gens ≈ 51/day. FOOTAGE REFRESH contributes nothing — it makes no model calls (§5.0) | ~14,400/day | huge |
| GitHub Actions minutes | hourly WATCH × 24 (~1 min each) + 3 render jobs × ~5 min (FFmpeg is the expensive part) + weekly footage job (~15–20 min — a headless Chromium launch per candidate adds a little over the old yt-dlp job) ≈ ~40 min/day amortized | 2,000 min/mo private | fine — public repo removes the ceiling entirely |
| KV writes | batch manifest + rate-limit counters + 3 export blobs ≈ well under 50 | 1,000/day | fine |
| KV storage | 3 exports/day × 3-day TTL ≈ ~9 exports resident at once × (MP4 size, TBD — see §3's `ExportDriver` note) | 1GB total | needs the real render-size check before this is a settled "fine," not before |
| Edge TTS | 3 × ~150 words ≈ 450 words/day | no formal quota — it's not a real product | **the actual risk isn't quota, it's the endpoint disappearing.** Alert loudly on TTS driver failure, don't silently fall back to a paid provider without telling the operator |

RESEARCH is the one stage whose *token* cost grows with how hard it works: up to 6 iterations, each re-sending the whole conversation plus ~500 tokens of tool schemas, plus up to 6,000 characters per source read. Budgeted at roughly 15–25K tokens per render, ~75K/day for three — which is why it runs on `gpt-oss-20b`, against that model's own 200K/day, rather than eating into the 120b budget SCRIPT and CRITIC need. If it ever threatens that ceiling, the levers are `maxIterations` and `article-fetch.ts`'s `maxChars`, in that order.

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
