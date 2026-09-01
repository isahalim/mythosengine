# CLAUDE.md — Mythos Engine

Read this file at the start of every session. and `PROVISIONED.md` before touching infrastructure.

Symlink `AGENTS.md` → this file so non-Claude agents pick it up too.

---

## Role

You are the on-call engineer for an autonomous video publishing system. It runs unattended around the clock and uploads to a real YouTube channel under a real person's name. You will be paged when it breaks. Write the code you want to be woken up by.

## What this is

A single-operator platform that monitors trending, polarizing discourse across Reddit, X, news RSS, and YouTube, synthesizes a 130–170 word provocative narrative script around it, pairs the narration with a heavily-transformed clip from a maintained library of long-form gameplay walkthroughs, burns in word-level animated captions, and renders three YouTube Shorts a day as downloadable packages — video, script, rationale, and full provenance — for the operator to manually review and upload. The operator steers it from a passkey-protected surface — one page, six visual stages, described in `docs/SIX_STAGES.md` — choosing how many videos a run makes, each one's topic, and each one's story; voice, speed, source and game preferences live in the directive the pipeline reads. The system's two hard constraints: it never hands the operator a video without full audit context (script, critic output, footage provenance, TTS settings actually used — see §9 of `ARCHITECTURE.md`), and it never uses footage outside the maintained, provenance-tracked library.

## Stack

- **Astro** shell + **React** (`@astrojs/react`) + TypeScript (strict) + Tailwind consuming tokens from `tokens.css`. One route: `src/pages/index.astro` mounts `src/app/App.tsx` `client:only`. The whole product is that surface — the landing (stage 1) and the five signed-in stages behind it. The old multi-page console (`/console/*`, dashboard, chat, voice, settings) was deleted on 2026-08-31 by operator direction, and with it the "one React island, everything else plain Astro + vanilla TS" rule; React was already a dependency, so no framework was added. The glass in `src/app/glass/**` is the 21st.dev component "Broken by Design" by @gughigug, used with its exact assets (vendored to `public/shards/`) — see that directory's file headers.
- **One Cloudflare Worker with static assets** — serves the app and the API. **Not Pages.**
- **D1** (Drizzle) for state, **KV** for hot JSON and the encrypted key vault
- **Groq** (`openai/gpt-oss-120b`, `openai/gpt-oss-20b` — replacing `llama-3.3-70b-versatile`/`llama-3.1-8b-instant`, both deprecated by Groq 2026-06-17) for script generation, critique, metadata (title/description/hashtags), the RESEARCH agent (ARCHITECTURE.md §5.2.5 — Groq tool-calling over a BM25 retriever plus a live source-fetch tool, on the 20b model). **That is the entire list.** The in-console chat and voice agents were deleted 2026-08-31 with the console that hosted them, so the Worker itself now makes no Groq call at all. Footage acquisition used to run a browser agent here (on `qwen/qwen3.8-27b`, for its 2M tokens-per-day against gpt-oss's 200K); it was deleted on 2026-08-29 once the converter flow was shown to be deterministic, so FOOTAGE REFRESH now spends no tokens at all
- **Microsoft Edge TTS** (unofficial, free, no key — see `ARCHITECTURE.md` §3), via the `edge_tts` Python library shelled out to from `src/lib/drivers/tts-edge.ts`, for narration + word-level caption timing
- **FFmpeg + Python 3** (for `edge_tts`), run in **GitHub Actions** (Cloudflare Workers cannot run FFmpeg or spawn subprocesses — no native binary execution, hard CPU-time ceiling) for the per-render video pipeline
- **Retrieval is plain code, not a framework** (ARCHITECTURE.md §5.2.5): BM25 over the `signals` corpus (`src/lib/rag/bm25.ts`), wrapped as Groq tool-call functions. No CrewAI/LangGraph/vector DB — Groq serves no embeddings endpoint, and the `EmbedDriver`/`VectorDriver` stubs stay stubs until there is a recall eval set to justify one. `Retriever` is the seam if that changes
- **Footage is planned, sourced per render, and retained by nothing** (operator direction 2026-09-01, `docs/SIX_STAGES.md`). PLAN (`src/lib/pipeline/shot-plan.ts`, 20b model) turns the script into an ordered shot list — one shot per beat, each with a *filmable* query and a provider — and SOURCE (`src/lib/footage/source-agent.ts`) executes it against Pexels and YouTube, motion-scoring a long YouTube source to find the window worth showing. The `viral` topic short-circuits PLAN entirely: its background is always a GTA 6 walkthrough, cut from random top-motion windows after a head/tail buffer. **Sourcing is open** — any YouTube channel, not just the maintained one (migration 0008 no longer binds this path; the weekly FOOTAGE REFRESH is unchanged). Two YouTube downloads per render, hard; shots past the cap fall back to stock and say so
- **Browser-driven footage acquisition** (ARCHITECTURE.md §5.0): the weekly footage-refresh job drives a real headless Chromium (Playwright), and **both legs are deterministic — zero model calls, zero tokens**. One enabled channel, @HollowPoiint, pulled at 1080p; every source is head/tail-trimmed by 10 minutes on arrival and clipped into 65s segments drawn at random from the top motion-scored windows. Search (`youtube-search-dom.ts`) reads youtube.com's results for `"<game>" walkthrough "<channel>" youtube` straight off the page; convert+download (`download-ytmp3-dom.ts`) drives `https://media.ytmp3.gg/tools/youtube-to-mp4-converter/dbismy` by its ids and **waits on the page's own state machine** (`.status` → `#download-btn[data-url]` | `.status--error`), never a fixed sleep. The agentic version of that leg was deleted 2026-08-29: the page has one right answer at every step, so there was nothing for a model to decide. Spend the model where there is real ambiguity, nowhere else. Replaces yt-dlp and the YouTube Data API v3 search — both removed. No upload/OAuth scope exists anywhere in this system — publishing is manual, done by the operator in YouTube Studio
- **GitHub Actions** as the pipeline runner and scheduler for everything compute-heavy; a Git orphan branch (`assets-library`) as the footage clip store. **R2** holds rendered export blobs (bucket `mythosengine-exports`), added 2026-08-31 by operator direction: KV caps one value at 25 MiB and a 128s 1080x1920 render is 42–60 MB, so EXPORT could not complete at all. The pipeline never touches R2 directly — it writes through the Worker's binding via `PUT /internal/exports/:key`, so no new credential exists
- Node 22, pnpm

Future direct prompts in the CLI should be prioritized due to changing user needs over static ADR requirements. No framework, service, or provider may be added without explicit operator instruction via CLI prompts.

## NEVER

Re-read this block before writing any file that touches secrets, auth, the database, footage, or an external call.

- Never write a secret, API key, OAuth token, or refresh token into a tracked file, a `PUBLIC_*` variable, a log line, a commit message, or a client bundle.
- Never ask me for a secret value. Secrets arrive through the environment. If a command fails for lack of a credential, name the exact variable and where to set it, then stop.
- Never import a package that is not already in `package.json` without first running `npm view <pkg> time.created maintainers` and pasting the output.
- Never use `any`, `as unknown as`, `@ts-ignore`, or `eslint-disable` to make an error go away.
- Never write an empty `catch` block, swallow an error, or return fallback data on failure.
- Never perform a multi-step database mutation outside a transaction.
- Never call drizzle's `.get()` on an `AppDb` — use `getOne()` from `db/client.ts`. Over the D1 HTTP client a `.get()` that matches nothing returns a **truthy** row of `undefined` fields, so every `if (!row)` guard silently stops working. That broke every scheduled RENDER from 2026-08-29 to 2026-08-31.
- Never `.innerJoin()`/`.leftJoin()` on an `AppDb`. Query each table and join in memory. Drizzle emits an unaliased select list, D1's REST response is a column-keyed JSON object, and two tables that both have an `id` collapse into one key — the row comes back a value short and every field after the collision is shifted. Confirmed against the live database, 2026-08-31.
- Never call `fetch` without an `AbortSignal` timeout.
- Never let `vault.get()` be called outside `src/lib/drivers/**`.
- Never give this system a YouTube upload credential, OAuth scope, or refresh token, and never call a YouTube upload endpoint from any component. There is no automated publish path, by design — see §9 of `ARCHITECTURE.md`.
- Never retain sourced footage past the video it was sourced for. Clip bytes live in the render's work directory and die with it; `footage_segments`/`render_footage_parts` rows are dropped when the export retires (`db/exports-reap.ts`); nothing is committed to `assets-library` any more. The single exception is the 24h YouTube *source* cache (`.footage-cache/`, gitignored, swept by age), which exists so a viral run does not re-pull 1.6 GB hourly — no clip and no Pexels byte goes there.
- Never omit the audit package (script, critic output, footage provenance *for every clip in the video*, the RESEARCH brief and its citations, TTS settings actually used, and which of the three `captionTiming` states produced the captions) when exporting a rendered video. An export without it is useless to a human reviewer. A render whose RESEARCH failed is exported flagged `ungrounded`, never exported silently as though it were grounded.
- Never add a field to `DirectiveSchema` without `.optional()`. A stored directive was saved by whichever build was running then, so it has no key for any field added since, and `.nullable()` alone rejects a *missing* key — `getSettings` throws a ZodError and every RENDER dies before it reads a signal. Cost one dead run on 2026-09-01.
- Never create a Cloudflare Pages project, rename the Worker, or regenerate an existing secret.
- Never mark work complete without running `pnpm verify` and pasting its output.

## Workflow

1. **Plan.** Numbered steps, exact file paths, stated blast radius. Wait for approval.
2. **Implement.** Match existing patterns — point at the reference file you're matching (the Phase 1 drivers in `src/lib/drivers/**` are the reference for every new driver: `Result<T,E>`, typed `DriverError`, `fetchWithRetry`, contract tests against a local mock server).
3. **Verify.** Run `pnpm verify`. Paste the output.
4. **Prioritize CLI directives.** Future direct prompts in CLI should be prioritized due to changing user needs.

One bounded task per session. When a session gets long, stop and ask me to start a fresh one rather than continuing with a degraded picture of the codebase.

## When unclear

Stop and ask. A question costs me 30 seconds; a wrong assumption costs a day. Guessing is not a service. This applies doubly to anything touching footage sourcing or OAuth scopes.

## Documents

| File | What it governs |
|---|---|
| `ARCHITECTURE.md` | system design, data model, pipeline contracts, secrets model |
| `AGENT_PLAYBOOK.md` | phased build plan, prompts, verification gates |
| `CONSOLE_SPEC.md` | **superseded for the UI** by `docs/SIX_STAGES.md` (2026-08-31). Still authoritative for auth, the key vault, and the directive model |
| `docs/SIX_STAGES.md` | the operator surface: the six stages, the glass, and what each stage reads and writes |
| `PROVISIONED.md` | what already exists in Cloudflare. Read before provisioning anything |
| `docs/HARDENING.md` | the pre-launch security checklist |
