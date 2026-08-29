# CLAUDE.md — Mythos Engine

Read this file at the start of every session. and `PROVISIONED.md` before touching infrastructure.

Symlink `AGENTS.md` → this file so non-Claude agents pick it up too.

---

## Role

You are the on-call engineer for an autonomous video publishing system. It runs unattended around the clock and uploads to a real YouTube channel under a real person's name. You will be paged when it breaks. Write the code you want to be woken up by.

## What this is

A single-operator platform that monitors trending, polarizing discourse across Reddit, X, news RSS, and YouTube, synthesizes a 130–170 word provocative narrative script around it, pairs the narration with a heavily-transformed clip from a maintained library of long-form gameplay walkthroughs, burns in word-level animated captions, and renders three YouTube Shorts a day as downloadable packages — video, script, rationale, and full provenance — for the operator to manually review and upload. The operator steers it from a passkey-protected console, including which voice, speed, script source, and game each run favors. The system's two hard constraints: it never hands the operator a video without full audit context (script, critic output, footage provenance, TTS settings actually used — see §9 of `ARCHITECTURE.md`), and it never uses footage outside the maintained, provenance-tracked library.

## Stack

- **Astro** + TypeScript (strict) + Tailwind consuming tokens from `tokens.css` — the operator console only. There is no public-facing content site; the Worker's public surface is a status/marketing page at most. One `@astrojs/react` island (`src/console/components/PromptInputBox.tsx`, `/console/chat` only) is the sole exception to "no framework beyond Astro" — everything else, including every other console page, stays plain Astro + vanilla TS.
- **One Cloudflare Worker with static assets** — serves the console and the API. **Not Pages.**
- **D1** (Drizzle) for state, **KV** for hot JSON and the encrypted key vault
- **Groq** (`openai/gpt-oss-120b`, `openai/gpt-oss-20b` — replacing `llama-3.3-70b-versatile`/`llama-3.1-8b-instant`, both deprecated by Groq 2026-06-17) for script generation, critique, and metadata (title/description/hashtags)
- **Microsoft Edge TTS** (unofficial, free, no key — see `ARCHITECTURE.md` §3), via the `edge_tts` Python library shelled out to from `src/lib/drivers/tts-edge.ts`, for narration + word-level caption timing
- **FFmpeg + Python 3** (for `edge_tts`), run in **GitHub Actions** (Cloudflare Workers cannot run FFmpeg or spawn subprocesses — no native binary execution, hard CPU-time ceiling) for the per-render video pipeline
- **Agentic footage acquisition** (ARCHITECTURE.md §5.0): the weekly footage-refresh job drives a real headless Chromium (Playwright) through a bounded Groq tool-calling loop (`src/lib/drivers/browser-agent-core.ts`) to search youtube.com directly for `"<game>" walkthrough "<channel>" youtube`, then convert+download the top result via `https://media.ytmp3.gg/tools/youtube-to-mp4-converter/dbismy`. Replaces yt-dlp and the YouTube Data API v3 search — both removed. No upload/OAuth scope exists anywhere in this system — publishing is manual, done by the operator in YouTube Studio
- **GitHub Actions** as the pipeline runner and scheduler for everything compute-heavy; a Git orphan branch (`assets-library`) as the footage clip store — no R2, no paid object storage
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
- Never call `fetch` without an `AbortSignal` timeout.
- Never let `vault.get()` be called outside `src/lib/drivers/**`.
- Never give this system a YouTube upload credential, OAuth scope, or refresh token, and never call a YouTube upload endpoint from any component. There is no automated publish path, by design — see §9 of `ARCHITECTURE.md`.
- Never omit the audit package (script, critic output, footage provenance, TTS settings actually used) when exporting a rendered video. An export without it is useless to a human reviewer.
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
| `CONSOLE_SPEC.md` | operator console: auth, key vault, directives, dashboard |
| `PROVISIONED.md` | what already exists in Cloudflare. Read before provisioning anything |
| `docs/HARDENING.md` | the pre-launch security checklist |
