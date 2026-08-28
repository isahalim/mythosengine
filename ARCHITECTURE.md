# Autonomous Game-Content Site — System Architecture

**Version:** 1.1 — object storage and GPU removed; operator console added.
**Owner:** single operator (you). One human account, passkey-authenticated. No public sign-ups.
**Prime directive:** every runtime dependency has a **permanent** free tier reachable **without entering a credit card**.

---

## 0. The stack, and what it costs

| Service | Permanent free? | Card-free? | Role |
|---|---|---|---|
| **Groq Cloud** (Llama 3.3 70B, Whisper) | Yes — rate-limited, no credit system | **Yes** | Primary LLM. ~30 req/min, ~6k tokens/min, ~14.4k req/day, enforced **per organization** (extra keys don't raise limits) |
| **Cloudflare Workers static assets** | Yes | **Yes** | Hosts the static site *and* the API in one deployment. Cloudflare's recommended path for new projects since Workers reached asset parity with Pages |
| **Cloudflare Workers** | 100k req/day | **Yes** | API layer, console backend, auth |
| **Cloudflare D1** | 5 GB, 5M row-reads/day | **Yes** | Pipeline state, claims, runs, audit log |
| **Cloudflare KV** | 1 GB, 100k reads/day, **1k writes/day** | **Yes** | Hot manifests, rate-limit counters, encrypted key store |
| **Cloudflare Turnstile** | Yes | **Yes** | Bot protection on the one public POST route |
| **GitHub Actions** | 2,000 min/mo private, unlimited public | **Yes** | Pipeline runner + scheduler |
| **YouTube** | Yes | **Yes** | The only video store. Full stop |

**Removed from v1.0 and why:**

- **Cloudflare R2** — activating it requires a payment method even for the free 10 GB, and with video on YouTube there is nothing left that needs object storage. Site images are build-time static assets served by the Worker (unlimited, free); mutable JSON lives in KV.
- **Amazon SageMaker / any GPU** — the pipeline produces publishable output with zero GPU calls. Post cards use YouTube's own thumbnail URLs (`i.ytimg.com/vi/<id>/maxresdefault.jpg`); OG images are generated deterministically at build time with `satori` + `resvg`. No inference, no storage, no card.

**Video handling, final:** the system never touches a video byte. It stores a `youtube_id`, the transcript, chapter timestamps, and a clip manifest (`{start, end, label}` arrays for footage references). Playback is an embedded YouTube iframe, lazy-loaded via `lite-youtube-embed` so an embed costs ~3 KB instead of ~700 KB until clicked.

> Quotas change. Treat every number here as **unverified at runtime**. `scripts/verify-quotas.mjs` (Phase 0) re-checks them and warns on drift.

---

## 1. Design principles

1. **Everything is a driver.** No provider name appears in business logic. `llm.complete()`, `asr.transcribe()`, `vector.search()`, `cache.put()` are interfaces; providers are adapters selected by env. Directly answers *Interface Abstraction & Decoupling* and *Context Drift* from your failure-mode doc.
2. **The repository is the database of record.** Published content is MDX committed to Git. D1/KV are derived caches that can be rebuilt from the repo. This gives you free audit trails, free rollback, and free "who changed what" — closing your Compliance/Auditability gap without buying anything.
3. **The pipeline is a state machine, not a prompt chain.** Every item moves through explicit states with a persisted row. A crashed run resumes; it does not restart.
4. **The model never publishes.** The model *proposes*. A deterministic gate (schema validation + citation verification + link liveness + policy lint) decides. Autonomy comes from the gate being reliable, not from trusting the model.
5. **Zero secrets in the browser.** The static site is public and dumb. Anything with a key runs in a Worker or in GitHub Actions.
6. **Cheap to be wrong.** Every stage is idempotent and keyed, so a retry never double-publishes and never double-charges a quota.

---

## 2. Topology

```
   YOU ──passkey──► console.mythosengine.dev  ┐
                    ┌───────────────────────┐ │  writes directives, rotates keys,
                    │  OPERATOR CONSOLE     │ │  reads run history, approves/kills
                    │  bento dashboard      │ │
                    │  directive composer   │ │
                    │  key vault UI         │ │
                    └───────────┬───────────┘ │
                                │ POST /console/* (WebAuthn session cookie)
                                ▼
┌──────────────────────── CONSOLE WORKER (Cloudflare) ───────────────────────┐
│  auth · directive versioning · encrypted key vault · run queries · kill sw │
└───────┬───────────────────────────────┬────────────────────────────────────┘
        │ reads/writes                  │ repository_dispatch (manual re-run)
        ▼                               ▼
   ┌──────────┐  ┌────────────┐   ┌──────────────────────────────────────────┐
   │ D1 (SQL) │  │ KV         │   │  SCHEDULER — GitHub Actions cron (free)  │
   │ items    │  │ enc. keys  │   │  */30 ingest  ·  hourly build  ·  daily  │
   │ claims   │  │ hot JSON   │   └───────────────────┬──────────────────────┘
   │ runs     │  │ ratelimits │                       │ pulls directives + keys
   │ audit    │  └────────────┘                       ▼
   │ directive│                 ┌──────────── PIPELINE RUNNER (Node/TS) ─────────────┐
   └──────────┘                 │ 1 WATCH ▸ 2 NORMALIZE ▸ 3 DEDUPE ▸ 4 RETRIEVE      │
        ▲                       │   ▸ 5 DRAFT ▸ 6 CRITIC ▸ 7 GATE ▸ 8 COMMIT         │
        │ writes state          └──┬──────────────────┬──────────────────┬───────────┘
        └──────────────────────────┘                  │                  │
                                                      ▼                  ▼
                                            ┌──────────────┐    ┌────────────────┐
                                            │  GROQ API    │    │   GIT REPO     │
                                            │ llama-3.3-70b│    │ content/*.mdx  │
                                            │ whisper-v3   │    │ (source of     │
                                            └──────────────┘    │  truth)        │
   ┌──────────┐                                                 └───────┬────────┘
   │ SOURCES  │ ──► WATCH                                               │ push
   │ RSS/Atom │                                                         ▼
   │ YT RSS   │                                        ┌────────────────────────────┐
   │ Steam    │                                        │  BUILD (Actions):          │
   │ Reddit   │                                        │  astro build + satori OG   │
   └──────────┘                                        │  → wrangler deploy         │
                                                       │  (Worker + ./dist assets)  │
                                                       └─────────────┬──────────────┘
                                                                     ▼
   READER ──► mythosengine.<sub>.workers.dev ──► static HTML ──► YouTube iframe (lazy)
                        ├─► /api/recent (KV, cached) · /api/ask (Turnstile + RL)
                        └─► /console/*  (passkey-gated, same Worker)
```

**Why GitHub Actions is the runner and not a Worker:** Workers have a CPU-time ceiling per request and no long-running job model on the free plan. The pipeline is a batch job with minute-scale LLM waits. Actions gives you 2,000 free minutes/month on private repos (unlimited on public), a real filesystem, and a secret store — with zero card.

---

## 3. Provider abstraction

`config/providers.ts` is the only file that knows brand names.

```ts
// config/providers.ts — the ONLY place vendor names appear
export const config = {
  llm:    pick(env.LLM_DRIVER,    ['groq', 'workers-ai', 'openai-compat'] as const),
  asr:    pick(env.ASR_DRIVER,    ['groq-whisper', 'yt-captions', 'none'] as const),
  embed:  pick(env.EMBED_DRIVER,  ['local-minilm', 'workers-ai'] as const),
  vector: pick(env.VECTOR_DRIVER, ['sqlite-vec', 'd1-hybrid'] as const),
  cache:  pick(env.CACHE_DRIVER,  ['kv', 'memory'] as const),   // hot JSON only, never blobs
} as const;
```

**Default profile (`profiles/free.env`)** — the only profile that has to work:

```
LLM_DRIVER=groq
ASR_DRIVER=yt-captions         # free, no quota; falls back to groq-whisper when captions absent
EMBED_DRIVER=local-minilm      # transformers.js in the Actions runner — no API, no quota
VECTOR_DRIVER=sqlite-vec       # local SQLite index, committed as a build artifact
CACHE_DRIVER=kv
```

There is no second profile. If a provider ever needs replacing, you write one adapter file and change one env var — that is the entire point of the layer, and it is cheaper than carrying dead configuration for services you decided not to use.

Every adapter implements the same interface **and the same failure contract**: typed errors, explicit timeout, bounded retries with jitter, and a `quota` field on every response so the runner can back off before it gets 429'd.

```ts
export interface LlmDriver {
  complete(req: LlmRequest): Promise<Result<LlmResponse, LlmError>>;
  // Result<> not exceptions — forces call sites to handle failure (kills "happy path" bias)
}
```

---

## 4. Data model (D1 / SQLite — identical schema both places)

```sql
CREATE TABLE sources (
  id            TEXT PRIMARY KEY,          -- 'rockstar-newswire'
  kind          TEXT NOT NULL CHECK (kind IN ('rss','youtube','steam','reddit','html')),
  url           TEXT NOT NULL,
  trust_tier    INTEGER NOT NULL CHECK (trust_tier BETWEEN 1 AND 3), -- 1=official
  franchise     TEXT NOT NULL,             -- 'gta6' | 'wolverine' | ...
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_seen_at  TEXT
);

CREATE TABLE items (                        -- one raw thing observed in the world
  id            TEXT PRIMARY KEY,          -- sha256(canonical_url) — natural key, idempotent
  source_id     TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  canonical_url TEXT NOT NULL,
  title         TEXT NOT NULL,
  published_at  TEXT NOT NULL,
  raw_hash      TEXT NOT NULL,
  simhash       TEXT NOT NULL,             -- near-dup detection
  state         TEXT NOT NULL CHECK (state IN
                  ('observed','deduped','retrieved','drafted','critiqued',
                   'gated','published','rejected','failed')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  UNIQUE (source_id, canonical_url)
);

CREATE TABLE claims (                       -- every factual assertion the model makes
  id            TEXT PRIMARY KEY,
  item_id       TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  text          TEXT NOT NULL,
  support_url   TEXT,                       -- NULL => unsupported => blocks publish
  support_span  TEXT,
  confidence    REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1)
);

CREATE TABLE runs (                         -- observability without an APM bill
  id            TEXT PRIMARY KEY,
  started_at    TEXT NOT NULL, finished_at TEXT,
  stage         TEXT NOT NULL, status TEXT NOT NULL,
  tokens_in     INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0,
  error_class   TEXT, trace_id TEXT NOT NULL
);

CREATE TABLE audit_log (                    -- append-only; never UPDATE, never DELETE
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at            TEXT NOT NULL, actor TEXT NOT NULL,   -- 'agent:draft' | 'human:you'
  action        TEXT NOT NULL, subject TEXT NOT NULL, detail_json TEXT NOT NULL
);

CREATE TABLE media_refs (                   -- YouTube references. No bytes, ever.
  id            TEXT PRIMARY KEY,
  item_id       TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  youtube_id    TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('source','published')),
  clip_start_s  INTEGER, clip_end_s INTEGER, label TEXT,
  CHECK (clip_end_s IS NULL OR clip_end_s > clip_start_s)
);

CREATE TABLE directives (                   -- operator steering, versioned and revertible
  version       INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at    TEXT NOT NULL,
  raw_text      TEXT NOT NULL,             -- exactly what you typed
  compiled_json TEXT NOT NULL,             -- parsed + schema-validated structure
  status        TEXT NOT NULL CHECK (status IN ('draft','active','superseded','reverted')),
  parent_version INTEGER REFERENCES directives(version)
);

CREATE TABLE credentials (                  -- WebAuthn passkeys. One human.
  credential_id TEXT PRIMARY KEY,
  public_key    BLOB NOT NULL,
  counter       INTEGER NOT NULL DEFAULT 0,
  transports    TEXT, created_at TEXT NOT NULL, last_used_at TEXT,
  label         TEXT NOT NULL              -- 'MacBook Touch ID', 'YubiKey 5'
);

CREATE INDEX idx_items_state_pub ON items(state, published_at DESC);
CREATE INDEX idx_claims_item     ON claims(item_id);
CREATE UNIQUE INDEX idx_directive_active ON directives(status) WHERE status = 'active';
-- ^ partial unique index: exactly one active directive can exist. Enforced by the database,
--   not by application logic, so a race cannot produce two competing sets of instructions.
```

Notes that map directly to your hardening checklist: natural-key `UNIQUE` constraints give you idempotency for free; `CHECK` constraints make illegal states unrepresentable at the database layer rather than in prompt instructions; `ON DELETE CASCADE` is explicit everywhere; `audit_log` is append-only.

---

## 5. Pipeline stages — contracts

Each stage is a pure-ish function `(input, deps) -> Result<output, error>`, with its own timeout, its own retry policy, and its own row transition. **A stage may only advance an item one state.**

### 1. WATCH
- Polls `sources` on a 30-min cron. Conditional GETs (`ETag`/`If-Modified-Since`) so you burn no quota on unchanged feeds.
- Zero-API-key sources to seed: publisher newswires (RSS), **YouTube channel RSS** (`https://www.youtube.com/feeds/videos.xml?channel_id=…` — no API key), Steam news API (`ISteamNews/GetNewsForApp`, no key), subreddit `.json` endpoints (set a real User-Agent), publisher press-site sitemaps.
- Output: `items` rows in `observed`.

### 2. NORMALIZE
- HTML → readable text (`@mozilla/readability` + `linkedom`), canonical URL resolution, `published_at` normalization to UTC ISO-8601.
- Video items: fetch transcript. If absent, `ASR_DRIVER=groq-whisper` on the audio. Never store the video.

### 3. DEDUPE
- `simhash` + 3-gram Jaccard against the trailing 30-day window. Same news from 12 aggregators collapses to one item, with the highest-`trust_tier` source promoted to primary and the rest attached as corroboration.
- This is the single highest-value stage for a games-rumor site: it's what separates you from slop farms.

### 4. RETRIEVE — the multi-RAG layer

Three retrievers, fused, then re-ranked. All free.

| Retriever | Implementation | Purpose |
|---|---|---|
| **Lexical** | SQLite FTS5 / BM25 over the item corpus | exact names, patch numbers, quotes |
| **Dense** | `all-MiniLM-L6-v2` via `transformers.js` in the runner, vectors in `sqlite-vec` | paraphrase + concept matching |
| **Canon** | Curated franchise fact-file (`data/canon/gta6.yml`) — confirmed facts, dates, platform lists, retracted rumors | prevents the model from re-litigating settled facts |

Fusion: **Reciprocal Rank Fusion** (`score = Σ 1/(60 + rank_i)`) — no tuning, no training, robust. Re-rank the top 30 down to 8 chunks with a cheap Groq call (`llama-3.1-8b-instant`) scoring relevance 0–10, so you spend your 70B tokens on generation, not filtering.

Every retrieved chunk carries `{source_url, published_at, trust_tier, span}`. **A chunk without provenance is dropped**, not passed to the model.

### 5. DRAFT (Groq, `llama-3.3-70b-versatile`)
- Structured output only: JSON Schema → post object. Never free-form prose parsed with regex.
- The prompt receives *only* the 8 fused chunks + canon + the item. No general "what you know about GTA 6" — that's where hallucination enters.
- Every sentence in `body_blocks` must carry a `citation_ids[]` array referencing supplied chunk ids.

### 6. CRITIC (Groq, second pass, adversarial)
- Separate call, separate system prompt, **does not see the drafting prompt**. Its job is to fail the draft.
- Emits `claims` rows: for each factual assertion, is it (a) supported by a supplied chunk, (b) contradicted, or (c) unsupported?
- Rumor discipline: anything not from `trust_tier=1` must be linguistically marked as a report/rumor with attribution. The critic checks the hedging is present, since this is a site about *unreleased* games.

### 7. ASSETS (no GPU, no storage)
- Video reference: `youtube_id` only. The post renders `lite-youtube-embed`, which ships a poster image plus ~3 KB of JS and only loads the real iframe on click.
- Card/poster image: YouTube's own thumbnail URL for video items; for text items, a deterministic SVG composed from franchise tokens and the headline. No model, no file to store.
- OG image: rendered at **build time** with `satori` → `resvg` into a static PNG under `dist/og/`. Served as a static asset by the Worker, free and unlimited.
- Clip manifest: `{start, end, label, source_youtube_id}[]` persisted to D1 so a post can point at exact footage timestamps without hosting a frame of it.

### 8. GATE (deterministic — no model)
Fails closed. Publish only if **all** hold:
- JSON Schema validation passes (Zod).
- Zero claims with `support_url IS NULL`.
- Zero claims marked contradicted.
- Every cited URL returns 2xx/3xx on a HEAD request (link-liveness).
- Rumor hedging present when max `trust_tier > 1`.
- Similarity to the last 100 published posts < 0.85 (no accidental republishing).
- Word count, title length, and slug uniqueness within bounds.
- Policy lint: no reproduced source paragraphs (n-gram overlap with source text ≤ 12 consecutive words), no embedded copyrighted asset hotlinks.

### 9. COMMIT & DEPLOY
- Writes `content/posts/<yyyy>/<slug>.mdx` with full front-matter provenance.
- One semantic commit per post: `feat(gta6): trailer 2 analysis [item:sha256…]`. Not a 400-file monolith — directly addresses the *Unmaintainable Git History* failure mode.
- Push triggers the GitHub Actions build → `astro build` → `wrangler deploy` (Worker + `./dist` assets in one atomic deployment).
- KV hot-window refreshed with the last 14 days of post manifests as a **single JSON key** (`recent:v1`), rewritten once per publish batch. One write per batch, not per post — KV's 1,000 writes/day is the tightest Cloudflare limit you have.

---

## 6. Runtime API surface (Cloudflare Worker)

The static site needs almost no API. What exists is minimal and hardened:

| Route | Purpose | Protection |
|---|---|---|
| `GET /api/recent` | hot-window manifest from KV | cached, no auth needed, 60s edge TTL |
| `POST /api/ask` | optional RAG chat over your own posts | Turnstile token + sliding-window rate limit (KV counter) + origin allowlist + 400-token cap |
| `GET /healthz` | liveness | public |
| `GET /readyz` | D1 + KV reachability | public |
| `POST /auth/passkey/*` | WebAuthn register + authenticate | origin-bound, one allowed credential |
| `GET /console/*` | dashboard queries: runs, items, claims, directives | passkey session cookie, `__Host-` prefixed, HttpOnly, SameSite=Strict |
| `POST /console/directive` | new steering directive | session + CSRF token + schema validation |
| `POST /console/keys/:name` | validate-then-swap a provider key | session + reauth (fresh WebAuthn assertion < 5 min old) |
| `POST /console/dispatch` | trigger a pipeline run | session + rate limited to 10/hour |
| `POST /console/killswitch` | halt publishing immediately | session |

`/api/ask` is the only path where an anonymous browser causes an LLM call. It **proxies**; the browser never sees `GROQ_API_KEY`. Without the rate limiter, a single scraper drains your 14.4k daily requests in about eight minutes.

Full console design: **`CONSOLE_SPEC.md`**.

---

## 7. Secrets model — what keys you need and how they stay hidden

### Keys to create

| Key | Where you get it | Card? | Scope to request |
|---|---|---|---|
| `GROQ_API_KEY` | console.groq.com → API Keys | No | default |
| `CLOUDFLARE_API_TOKEN` | dash.cloudflare.com → My Profile → API Tokens → **Create Custom Token** | No | `Account:Workers Scripts:Edit`, `Account:Workers KV Storage:Edit`, `Account:D1:Edit`, `Account:Turnstile:Edit`. **Never** use the Global API Key |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard URL / Workers overview | No | not secret, but keep it out of client code |
| `GITHUB_TOKEN` | auto-injected in Actions | No | prefer the built-in token; only create a fine-grained PAT if you need cross-repo writes |
| `TWENTYFIRST_API_KEY` | 21st.dev/mcp | No | dev-machine only — **never** in CI or Workers |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | Cloudflare → Turnstile, **or created by the agent via API** (see below) | No | site key is public by design; secret key is server-only |
| `VAULT_MASTER_KEY` | you generate it: `openssl rand -base64 32` | No | AES-GCM key for the console's encrypted key store. Worker secret only |
| `SESSION_SIGNING_KEY` | `openssl rand -base64 32` | No | signs console session cookies |
| `SENTRY_DSN` *(optional)* | sentry.io free tier | No | DSN is semi-public; still keep it in env |

**The agent can create the Turnstile keys itself.** Cloudflare exposes `POST /accounts/{account_id}/challenges/widgets`, which needs a token carrying **Turnstile Sites Write** (`Account:Turnstile:Edit`). A Workers/KV/D1 token does not carry it by default, but you can *edit* an existing token's permissions in the dashboard rather than making a new one. With it, the agent can run:

```bash
curl "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/challenges/widgets" \
  --request POST \
  --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  --json '{"name":"mythosengine-console","mode":"managed",
           "domains":["mythosengine.<subdomain>.workers.dev","localhost"]}'
```

**This is already done — see `PROVISIONED.md`.** The widget exists and `TURNSTILE_SECRET_KEY` is set. Keep the recipe here for the day you add the custom domain, which needs the hostname list updated and `Zone:Edit` on the token. The agent cannot *register* `mythosengine.dev`; a `.dev` registration is a paid transaction at a registrar, and `.dev` is HSTS-preloaded so it is HTTPS-only from day one. Until then everything runs on `mythosengine.<subdomain>.workers.dev`, console at `/console`.

### Where each key lives

```
Developer machine    →  .env.local          (gitignored, chmod 600)   [21st.dev key, local dev]
GitHub Actions       →  Repository Secrets  (Settings ▸ Secrets ▸ Actions)
                        GROQ_API_KEY, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
Cloudflare Worker    →  wrangler secret put (write-only, unreadable afterwards)
                        GROQ_API_KEY, TURNSTILE_SECRET_KEY, VAULT_MASTER_KEY, SESSION_SIGNING_KEY
Console key vault    →  KV, AES-GCM encrypted under VAULT_MASTER_KEY  [rotatable provider keys]
Astro client bundle  →  NOTHING. Ever.
```

`GITHUB_TOKEN` inside Actions is auto-injected per run — you never create or store it. It is scoped to the repo and expires when the job ends. You only need a fine-grained PAT if the console Worker triggers workflows via `repository_dispatch`; scope that one to a single repo with `actions: write` and nothing else.

### The rules that actually prevent leakage

1. **Prefix discipline.** In Astro, only `PUBLIC_*` variables reach the browser (Vite's equivalent of `NEXT_PUBLIC_`/`REACT_APP_`). Add a build-time assertion that throws if any `PUBLIC_*` name matches `/KEY|SECRET|TOKEN|PASSWORD|DSN/i`.
2. **Post-build bundle scan.** A CI step greps `dist/` for each secret's *value* (not name) and for high-entropy strings. Fails the build on a hit. This is the step that catches the case where an SSR component accidentally serialized a server object into the HTML payload — the most common real-world leak in generated code.
3. **`gitleaks detect --no-git` on the working tree + `gitleaks detect` on full history**, in CI and as a pre-commit hook. Prototyping iterations are where keys get committed.
4. **Never send a key to the browser to "save a hop."** If the client needs LLM output, it hits your Worker. Non-negotiable.
5. **Rotate on the day of first deploy.** Any key that existed while the agent was iterating should be considered burned — agents paste keys into logs, error messages, and commit messages.
6. **Worker secrets are write-only.** After `wrangler secret put GROQ_API_KEY`, the value can't be read back from the dashboard. Store your own copy in a password manager, not in the repo.
7. **Least privilege on Cloudflare.** A token scoped to Workers, KV, D1, and Turnstile cannot be used to nuke your DNS if it leaks.

---

## 8. Frontend architecture & the hero

### Stack
- **Astro** with islands. Static by default; the hero is the only hydrated island. Chosen over Next.js because 95% of the site is content pages and you get near-zero JS on article routes — which keeps Core Web Vitals green without a bundle-splitting fight.
- **Tailwind + a token layer.** Tokens defined once in CSS custom properties; Tailwind consumes them. The agent is forbidden from writing raw hex values outside `tokens.css`.
- **Content Collections** with a Zod schema for MDX front-matter — the same schema the pipeline validates against, imported from one shared package. Single source of truth between generator and renderer.

### Hero: "ideation becoming reality"

The signature element, stated as a design thesis so the agent doesn't drift into a generic gradient-blob:

> A single bead of liquid metal rests on a dark, veined surface. It is unresolved — a mercury blob holding a smeared, unreadable reflection. As the pointer moves (or as the page scrolls on touch), surface tension breaks and the bead *resolves*: the reflection sharpens into the featured game's key art, the blob's silhouette settling into the shape of the franchise mark. Ideation → reality, rendered literally, in one gesture.

Implementation constraints, because a WebGL hero is where free-tier sites go to die:

- **Budget: ≤ 60 KB gzipped for the hero island**, measured in CI. Use `ogl` or raw WebGL2 with a hand-written GLSL fragment shader (raymarched metaballs + environment-map reflection). Do **not** pull in the full `three` + `@react-three/fiber` + `drei` stack for one effect; that's 400 KB+ and it will show up as a Core Web Vitals regression.
- **Progressive enhancement, three tiers:**
  1. No JS / crawler → static poster `<img>` with the resolved key art. The hero's *content* is always present in HTML.
  2. `prefers-reduced-motion: reduce` → the resolved still frame plus a slow opacity crossfade. No pointer-driven distortion.
  3. WebGL2 available and device passes a quick perf probe (≥ 30 fps over 500 ms) → full shader. Any failure downgrades silently to tier 1.
- **Never blocks LCP.** The poster image *is* the LCP element; the canvas fades in over it after `requestIdleCallback`.
- **Pause when off-screen** via `IntersectionObserver`, and cancel the RAF loop on unmount — your failure-mode doc's *Client-Side Memory & Lifecycle Leaks* item, which shader heroes violate constantly.

### Proposed direction (revise, don't accept blindly)

Deliberately avoiding the three defaults that AI-generated design clusters into (cream + serif + terracotta; near-black + one acid accent; broadsheet hairlines).

```
Palette — "wet slate"
  --ink        #10131A   deep blue-black, the leaf-in-shadow ground
  --slate      #232A36   panel / card
  --mercury    #C9D2DA   the metal; also the primary text color
  --oxide      #2F6B57   oxidized copper-green, the "leaf" accent — used ONLY for state and provenance
  --sodium     #E8944A   warm amber CTA, borrowed from streetlight-at-night key art
  --bone       #F2EFE9   rare high-contrast surface for pull-quotes

Type
  Display : a wide grotesk with tight tracking, set very large and very few times
            (Archivo Expanded / Bricolage Grotesque). Self-hosted via Fontsource — no
            Google Fonts request, no third-party origin, better privacy and LCP.
  Body    : a humanist sans with a real italic (Public Sans / Inter Tight)
  Utility : JetBrains Mono for timestamps, source tiers, patch numbers, confidence scores

Structure that means something
  Every post header shows a provenance strip: [ TIER 1 · OFFICIAL ] or [ TIER 3 · UNVERIFIED ]
  rendered in --oxide or --sodium. It is not decoration — it is the site's whole editorial
  claim, and it is generated from the pipeline's own trust data. That strip is the second
  signature element and the reason a reader trusts a site that a machine writes.
```

Spend boldness on the hero and the provenance strip. Everything else stays quiet: generous measure, one column, no card grids with hover-lift, no numbered `01 / 02 / 03` markers unless the content is genuinely sequential.

---

## 9. Quota budget (free-tier math)

Assume 6 published posts/day.

| Resource | Per-day consumption | Free ceiling | Headroom |
|---|---|---|---|
| Groq requests | ~48 poll-summaries + 6 drafts + 6 critics + ~30 re-ranks ≈ **90** | ~14,400/day | 160× |
| Groq tokens/min | draft ≈ 6k in / 1.5k out — **must be serialized**, one draft at a time | ~6k TPM | tight → the runner needs a token-bucket limiter |
| GitHub Actions | 48 ingest runs × ~1.5 min + 6 build runs × ~3 min ≈ **90 min** | 2,000 min/mo private, unlimited public | make the repo public or budget ~22 min/day |
| Worker deployments | 1–6 | no practical free-plan cap, but each is a full asset upload | **batch commits**; deploy once per publish batch, not per post |
| Workers requests | reader traffic | 100k/day | fine |
| D1 rows read | pipeline + `/api/*` | 5M/day | fine |
| KV writes | ~6 batch manifests + ~40 rate-limit counters ≈ **50** | 1,000/day | fine, but rate-limit counters must be **per-minute buckets with TTL**, not per-request writes |
| Console | your own browsing; D1 reads only | — | negligible |

The two real constraints: **Groq tokens-per-minute** (serialize LLM calls, never fan out) and **KV daily writes** (write on publish, not on read). If `/api/ask` ever gets real traffic, move rate limiting to a Durable Object or drop the route — it is optional.

---

## 10. Failure modes this design closes

Mapped to your ten-domain doc:

| Domain | Closed by |
|---|---|
| 1 Architecture | driver interfaces; repo-as-source-of-truth; one shared Zod schema between pipeline and renderer |
| 2 Security | no client keys; scoped tokens; Turnstile + rate limit on the only LLM-touching route; gitleaks in history + bundle scan; lockfile pinning |
| 3 Data integrity | natural-key UNIQUE constraints = idempotency; CHECK constraints; state machine with single-step transitions; migrations committed, never `db push` |
| 4 Reliability | `Result<>` instead of exceptions; per-stage timeouts; backoff + jitter; failed items park in a `failed` state with `attempts` — your DLQ, in SQL |
| 5 Verification | the GATE is the test suite for content; plus unit tests on dedupe/RRF/citation-verification, and Playwright E2E on the publish path |
| 6 Performance | static-first Astro; 60 KB hero budget enforced in CI; conditional GETs; batched commits |
| 7 Observability | `runs` + `audit_log` tables; structured JSON logs with `trace_id`; Discord webhook alert on gate-fail rate > 20% |
| 8 Compliance | Git history is the audit trail; `audit_log` append-only; no PII collected at all (the strongest possible GDPR posture) |
| 9 Maintainability | strict TS, no `any`, banned `@ts-ignore`; dead-code scan (`knip`) in CI |
| 10 Ownership | one semantic commit per post; `docs/DECISIONS.md` ADR log the agent must append to |
