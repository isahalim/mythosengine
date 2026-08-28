# AutoShorts AI — System Architecture

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
| **YouTube Data API v3** | Yes — 10,000 units/day default quota | **Yes** (Google account, no billing needed for this quota tier) | Upload, and the weekly footage-source discovery search |
| **Reddit RSS/Atom syndication feeds, News RSS** | Yes | **Yes** | Zero-key trend sources — **not** Reddit's JSON/Data API, see §5.1 |
| **X (Twitter) API** | **No** — the free tier has no meaningful search access as of 2026 | N/A | Not in the default profile. Driver exists, disabled unless the operator has a paid tier |
| **YouTube Community tab** | No official API | **Yes**, but unofficial/fragile | Best-effort source, same fragility contract as `yt-captions` had in the old project |

**What this costs in practice:** effectively $0/month at 3 uploads/day, with one caveat — Edge TTS is a free ride on an unofficial API, not a contractual guarantee. `config/providers.ts` keeps TTS behind the same driver interface as everything else specifically so a paid fallback (ElevenLabs, Groq TTS if it ships one) is a single env var away if Microsoft ever closes the endpoint off.

> Quotas and the Edge TTS endpoint's availability both change without warning. Treat every number here as **unverified at runtime**. `scripts/verify-quotas.mjs` re-checks the documented numbers against `src/config/quotas.ts` and warns on drift; it cannot detect an Edge TTS outage, only the pipeline's own retry/alerting can (§9).

---

## 1. Design principles

1. **Everything is a driver.** `llm.complete()`, `tts.synthesize()`, `downloader.fetch()`, `render.compose()`, `upload.publish()` are interfaces; providers are adapters selected by env, exactly as in the driver layer already built (`src/lib/drivers/**`). A provider swap is one new file and one env var.
2. **The repository is the database of record for the footage library.** Clips live on a git orphan branch with full provenance (source video id, channel, download timestamp, clip timestamp range) committed alongside them — not a mystery blob in someone's bucket.
3. **The pipeline is a state machine, not a prompt chain.** Every item — signal, script, render, upload — moves through explicit states with a persisted row. A crashed run resumes; it does not restart.
4. **The model never uploads.** The model *proposes* a script; a separate model pass *critiques* it; a deterministic POLICY GATE (§9) decides whether it's allowed anywhere near FFmpeg or the YouTube API. Autonomy comes from the gate being reliable, not from trusting the model — same philosophy MythosEngine used for citation verification, redirected at a different risk (channel suspension instead of misinformation).
5. **Footage acquisition is isolated, rate-limited, and the only place third-party video is fetched.** The daily render pipeline never touches the network for footage — it only reads from the already-vetted library. This is both a policy-risk control and a reliability one: a render job that doesn't depend on a live scrape can't fail because YouTube changed its page layout at 1pm.
6. **Zero secrets in the browser.** Static console assets are public; the OAuth tokens, the vault key, and the Groq key run only in a Worker or in GitHub Actions.
7. **Cheap to be wrong.** Every stage is idempotent and keyed. A retry never double-uploads and never re-downloads footage already in the library.

---

## 2. Topology

```
   YOU ──passkey──► console (Cloudflare Worker)   ┐
                    ┌───────────────────────┐     │  writes directives, approves
                    │  OPERATOR CONSOLE      │     │  uploads, reviews scripts,
                    │  render queue, upload  │     │  rotates keys, kills the run
                    │  approvals, key vault  │     │
                    └───────────┬───────────┘     │
                                │ POST /console/* (WebAuthn session cookie)
                                ▼
┌──────────────────────── CONSOLE WORKER (Cloudflare) ────────────────────────┐
│  auth · directive versioning · encrypted key vault · run/upload queries      │
└───────┬───────────────────────────────┬─────────────────────────────────────┘
        │ reads/writes                  │ repository_dispatch (manual re-run,
        ▼                               │ manual approve-and-upload)
   ┌──────────┐  ┌────────────┐         ▼
   │ D1 (SQL) │  │ KV         │   ┌───────────────────── SCHEDULER ───────────────────┐
   │ signals  │  │ enc. keys  │   │  GitHub Actions cron:                             │
   │ scripts  │  │ hot JSON   │   │   hourly  WATCH (trend ingestion)                 │
   │ segments │  │ ratelimits │   │   08/13/18 UTC  daily pipeline (script→upload)    │
   │ renders  │  └────────────┘   │   weekly  FOOTAGE REFRESH (§5.0)                  │
   │ uploads  │                   └───────────┬───────────────────┬────────────────────┘
   │ runs     │                               │                   │
   │ audit    │                               ▼                   ▼
   │ directive│                   ┌─────── PIPELINE RUNNER (Node/TS, GH Actions) ──────┐
   └──────────┘                   │ 1 WATCH ▸ 2 SCORE ▸ 3 SCRIPT ▸ 4 CRITIC/POLICY     │
        ▲                         │  ▸ 5 FOOTAGE SELECT ▸ 6 TTS+CAPTIONS ▸ 7 RENDER    │
        │ writes state            │  ▸ 8 GATE ▸ 9 UPLOAD                               │
        └─────────────────────────┴──┬──────────────────┬──────────────────┬──────────┘
                                     ▼                   ▼                  ▼
                           ┌──────────────┐    ┌──────────────────┐  ┌──────────────┐
                           │  GROQ API    │    │  EDGE TTS         │  │ FFmpeg (local │
                           │ llama-3.3-70b│    │ (unofficial, free)│  │  to the runner)│
                           └──────────────┘    └───────────────────┘  └──────┬────────┘
                                                                              │ finished .mp4
                                                                              ▼
   ┌─────────────────┐  weekly           ┌──────────────────────┐   ┌───────────────────┐
   │ WALKTHROUGH      │ ─────────────►   │ FOOTAGE REFRESH job   │   │  YouTube Data API  │
   │ CREATORS         │  yt-dlp download │  scene/motion scoring │   │  v3 (OAuth upload) │
   │ (long-form guides)│  (rate-limited)  │  → clip candidates    │   └─────────┬──────────┘
   └──────────────────┘                  └──────────┬────────────┘             │
                                                      ▼                          ▼
                                        ┌─────────────────────────┐   your YouTube channel,
                                        │ git orphan branch:       │   3 Shorts/day
                                        │ assets-library (clips +  │
                                        │ provenance metadata)     │
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
export const UPLOAD_DRIVERS   = ['youtube-data-api'] as const;
export const CACHE_DRIVERS    = ['kv', 'memory'] as const;
```

**Default profile (`profiles/free.env`)** — the only profile that has to work:

```
LLM_DRIVER=groq
TTS_DRIVER=edge-tts
DOWNLOAD_DRIVER=yt-dlp
RENDER_DRIVER=ffmpeg-local
UPLOAD_DRIVER=youtube-data-api
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

export interface UploadDriver {
  publish(req: UploadRequest): Promise<Result<{ videoId: string; url: string }, DriverError>>;
}
export interface UploadRequest {
  filePath: string;
  title: string;
  description: string;
  tags: string[];
  containsSyntheticMedia: true; // always true here — see §9. Confirm the exact
  // YouTube Data API v3 field name against current docs when Phase 6 implements
  // this; it has moved/been renamed before and must not be guessed at upload time.
}
```

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
                  ('observed','scored','scripted','critiqued','gated','uploaded','rejected','failed')),
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
  originality_score REAL,                    -- critic-assigned, see §9
  status        TEXT NOT NULL CHECK (status IN ('draft','approved','rejected'))
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
  duration_s    REAL,
  status        TEXT NOT NULL CHECK (status IN ('pending','rendered','failed')),
  gate_result   TEXT                          -- JSON: which POLICY GATE checks passed/failed
);

CREATE TABLE uploads (
  id            TEXT PRIMARY KEY,
  render_id     TEXT NOT NULL REFERENCES renders(id),
  youtube_video_id TEXT,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL,
  tags_json     TEXT NOT NULL,
  contains_synthetic_media INTEGER NOT NULL DEFAULT 1,
  uploaded_at   TEXT,
  status        TEXT NOT NULL CHECK (status IN ('pending_approval','approved','published','failed'))
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
  compiled_json TEXT NOT NULL,               -- focus games, tone, approval mode, banned topics
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
CREATE UNIQUE INDEX idx_directive_active ON directives(status) WHERE status = 'active';
```

Same rationale as before: natural-key `UNIQUE` gives idempotency for free, `CHECK` makes illegal states unrepresentable, `audit_log` is append-only, `footage_segments.used_count`/`last_used_at` is what lets FOOTAGE SELECT (§5.5) rotate clips instead of reusing the same 15 seconds every day.

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

### 3. SCRIPT (Groq, `llama-3.3-70b-versatile`)
- Structured JSON output only, `schemas/script.schema.json`. Fields: `hook` (≤3s read-aloud), `body`, `debate_question`, target 130–170 words total.
- The prompt receives the signal's title/summary and nothing else — no general "what you know about X," same hallucination-boundary discipline as MythosEngine's DRAFT stage.

### 4. CRITIC / POLICY-DRAFT-CHECK (Groq, second pass, adversarial, doesn't see the drafting prompt)
- Scores `originality_score` 0–1: does this script take a genuine angle, or does it just recite the signal back with narrator filler? Low scores block progression — this is the first half of the POLICY GATE story (§9).
- Flags anything resembling defamation of a named real person, medical/legal claims stated as fact, or content that reads as a verbatim repost of the source discussion.

### 5. FOOTAGE SELECT
- Picks a `footage_segments` row matching the directive's focus game(s), weighted away from recently-`last_used_at` segments. Increments `used_count`.

### 6. TTS + CAPTION SYNC (Edge TTS)
- `src/lib/drivers/tts-edge.ts` shells out to `scripts/edge_tts_synth.py`, a thin wrapper around the `edge_tts` Python library requesting `WordBoundary` events explicitly (the bare `edge-tts` CLI hard-codes sentence-level boundaries and has no flag to change that — confirmed by testing it directly, not assumed). Returns audio bytes plus one `{word, startMs, endMs}` entry per word — no separate forced-alignment step needed.
- Word timings become `captionCues` for RENDER: rendered as bold, high-contrast text that fades word-group to word-group, matching the reference style in `docs/DECISIONS.md`'s pivot entry.

### 7. RENDER (FFmpeg, local to the GitHub Actions runner)
- Crop/scale the footage segment to 1080×1920, filling ≥75% of frame height with gameplay (matches the "transformative" visual treatment the operator specified).
- Mute the source segment's original audio entirely; mix in the narration track.
- Burn in captions via an ASS subtitle file (word-timed fade, not a static SRT box) using FFmpeg's `ass` filter.
- Loop or trim the footage segment to the narration's exact duration.
- Headless export to MP4, `dist/render/<script_id>.mp4`, deleted after upload succeeds.

### 8. GATE (deterministic — no model call). See §9 for full detail. Fails closed.

### 9. UPLOAD (YouTube Data API v3, OAuth)
- LLM-generated title/description/hashtags, schema-validated.
- Sets the synthetic-media disclosure on the upload request (§9).
- Two approval modes per the active directive: `auto` (uploads immediately once GATE passes) or `manual` (parks in `uploads.status = 'pending_approval'`, surfaced on the console dashboard for a one-click approve — this is the "Hybrid Execution Control" goal).

---

## 6. Runtime API surface (Cloudflare Worker)

| Route | Purpose | Protection |
|---|---|---|
| `GET /healthz` | liveness | public |
| `GET /readyz` | D1 + KV reachability | public |
| `POST /auth/passkey/*` | WebAuthn register + authenticate | origin-bound, one allowed credential |
| `GET /console/*` | dashboard queries: runs, signals, scripts, renders, uploads, directives | passkey session cookie, `__Host-` prefixed, HttpOnly, SameSite=Strict |
| `POST /console/directive` | new steering directive | session + CSRF + schema validation |
| `POST /console/keys/:name` | validate-then-swap a provider key | session + reauth (< 5 min old) |
| `POST /console/dispatch` | trigger a pipeline run ad hoc | session + rate limited to 10/hour |
| `POST /console/scripts/:id/approve` | approve a `pending_approval` script | session |
| `POST /console/uploads/:id/approve` | approve a `pending_approval` upload | session + reauth |
| `POST /console/killswitch` | halt everything immediately | session |

No `/api/ask` this time — there's no public content site to chat against. The console is the entire authenticated surface; nothing here causes an anonymous browser to trigger an LLM or upload call.

Full console design: **`CONSOLE_SPEC.md`**.

---

## 7. Secrets model

| Key | Where you get it | Scope |
|---|---|---|
| `GROQ_API_KEY` | console.groq.com | default |
| `YOUTUBE_OAUTH_CLIENT_ID` / `_SECRET` | Google Cloud Console → OAuth consent screen + credentials | YouTube Data API v3, `youtube.upload` scope only |
| `YOUTUBE_OAUTH_REFRESH_TOKEN` | one-time consent flow run on the operator's machine, never in CI | long-lived, vault-managed, rotatable from the console like `GROQ_API_KEY` was |
| `YOUTUBE_API_KEY` | Google Cloud Console → Credentials → API Key, restricted to YouTube Data API v3 | read-only (`channels.list`/`search.list`/`videos.list`) — deliberately not the OAuth credential; footage discovery never needs upload-capable access |
| `CLOUDFLARE_API_TOKEN` | dash.cloudflare.com | Workers/KV/D1/Turnstile edit, no `Zone:Edit` |
| `VAULT_MASTER_KEY` / `SESSION_SIGNING_KEY` | `openssl rand -base64 32` | Worker secret only |
| `TWENTYFIRST_API_KEY` | 21st.dev | dev machine only, never CI/Workers |

Edge TTS needs no key at all — that's the entire appeal and the entire risk (§0).

**Where each key lives** — unchanged shape from MythosEngine: developer machine `.env.local` (gitignored), GitHub Actions Repository Secrets, `wrangler secret put` for the Worker, the console's own KV vault (AES-GCM under `VAULT_MASTER_KEY`) for rotatable provider keys including the YouTube refresh token. `CLOUDFLARE_API_TOKEN` stays outside the vault, same reasoning as before: a console that can rewrite its own infrastructure credentials is a privilege-escalation path.

---

## 8. Console frontend

Astro island(s) mounted only on `/console/*`, same `tokens.css` token discipline as before (a wet-slate palette is still a reasonable default — revise if you want AutoShorts to have its own visual identity, that's a cheap change). There is no public marketing hero to build here; skip straight to the dashboard. Full spec in `CONSOLE_SPEC.md`.

---

## 9. The POLICY GATE — why this project doesn't get suspended

YouTube's inauthentic-content policy (renamed from "repetitious content," July 2025) explicitly targets mass-produced, templated, reused-visual videos with a three-strike system: warning → 90-day Partner Program suspension → permanent removal. Naive automation — the exact "narrate a script over recycled B-roll on a timer" pattern this project builds — is precisely what it's aimed at. The GATE exists to keep this project on the right side of that line, the same way MythosEngine's citation gate kept it from publishing fiction as fact.

Fails closed. Publish only if **all** hold:

- JSON Schema validation passes on the script and the upload metadata (Zod).
- `originality_score` (from the CRITIC stage) clears a minimum bar — a script that's just narration over the source signal, no take, is rejected.
- Word count, hook length, and debate-question presence within bounds.
- The footage segment came from `footage_segments` (library-only, §1 NEVER) — a render referencing anything else is rejected before FFmpeg ever runs.
- The same `footage_segment_id` was not used in the last N renders (variety, tracked via `used_count`/`last_used_at`).
- Similarity to the last 100 uploaded scripts < 0.85 (no accidental self-repetition — the exact failure mode that reads as "templated" to YouTube's classifier).
- `containsSyntheticMedia` disclosure is set on the upload request — confirm the current Data API v3 field name at implementation time, don't guess it into the schema now.
- Caption/audio duration match within tolerance (a render where captions run past the narration audio is a rejection, not a "close enough").

Rejected items go to `state = 'rejected'` with the reason, surfaced in the daily digest — same pattern as before.

---

## 10. Quota & cost budget

Assume 3 uploads/day.

| Resource | Per-day consumption | Free ceiling | Headroom |
|---|---|---|---|
| Groq requests | ~24 score-passes + 3 scripts + 3 critics + 3 metadata-gens ≈ 33 | ~14,400/day | huge |
| YouTube Data API units | 3 uploads × 1,600 = 4,800/day, + weekly search ≈ 100–500 | 10,000/day | comfortable, watch it if search volume grows |
| GitHub Actions minutes | hourly WATCH × 24 (~1 min each) + 3 render jobs × ~5 min (FFmpeg is the expensive part) + weekly footage job (~15 min) ≈ ~40 min/day | 2,000 min/mo private | fine — public repo removes the ceiling entirely |
| KV writes | batch manifest + rate-limit counters ≈ well under 50 | 1,000/day | fine |
| Edge TTS | 3 × ~150 words ≈ 450 words/day | no formal quota — it's not a real product | **the actual risk isn't quota, it's the endpoint disappearing.** Alert loudly on TTS driver failure, don't silently fall back to a paid provider without telling the operator |

The two real constraints, updated from before: **YouTube API daily units** (a bad day of manual re-renders/re-uploads burns quota fast — 6 uploads/day is the hard ceiling on the free tier) and **Edge TTS's unofficial status** (this is a reliability risk, not a cost one — budget for it with retries and a loud alert, not with money).

---

## 11. Failure modes this design closes

| Domain | Closed by |
|---|---|
| Platform policy | the POLICY GATE (§9) — the single biggest existential risk to this project, addressed as a first-class deterministic stage, not an afterthought |
| Copyright/ToS exposure | footage acquisition isolated to one weekly, low-volume, fully-audited job; daily render never touches the network for footage |
| Architecture | driver interfaces; repo-as-source-of-truth for the footage library; one shared schema between pipeline and console |
| Security | no client keys; scoped OAuth (`youtube.upload` only, not full account access); Turnstile + rate limit on any public route; gitleaks in history + bundle scan |
| Data integrity | natural-key UNIQUE = idempotency; CHECK constraints; state machine with single-step transitions |
| Reliability | `Result<>` instead of exceptions; per-stage timeouts; backoff + jitter; a `failed` state with `attempts` as the DLQ |
| Observability | `runs` + `audit_log`; alert on GATE rejection rate, Edge TTS failure rate, or 3 consecutive stage failures |
| Maintainability | strict TS, no `any`, no `@ts-ignore`; `knip` in CI |
| Ownership | `docs/DECISIONS.md` ADR log, including this pivot itself |
