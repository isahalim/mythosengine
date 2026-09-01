# PROVISIONED — what already exists

Read before running any provisioning command. Everything here was created by the operator by hand, or by an earlier agent session under the operator's approval. **Do not recreate, rename, or regenerate any of it.**

Last updated: `2026-08-29`

> This infrastructure was originally provisioned for "MythosEngine" and carries over unchanged into the Mythos Engine pivot (same Worker, same secrets, same Turnstile widget) — only the product built on top of it changed. Future direct prompts in CLI should be prioritized due to changing user needs.

## Deployment

| Thing | Value | Notes |
|---|---|---|
| Worker name | `mythosengine` | pinned in `wrangler.toml`. Renaming orphans every secret below. Kept as the technical/internal name; the product is branded Mythos Engine in the console UI only |
| Live URL | `https://mythosengine.5ryfrrjgmg.workers.dev` | serving the Mythos Engine status page |
| Hosting model | Worker with static assets (`[assets] directory = "./dist"`) | **not** Cloudflare Pages |
| Custom domain | not registered | operator will handle |
| Entry point | `src/index.ts` | `/healthz`, `/readyz` (probes the real D1 + KV bindings as of 2026-08-28), `/auth/*` and `/console/*` routed by `src/server/router.ts` (Phase 8), falls through to `env.ASSETS` for everything else |
| CD | GitHub Actions (`.github/workflows/ci.yml`, `deploy` job) — push to `main`, gated on `verify` passing | Added 2026-08-27 |
| D1 migrations | `wrangler d1 migrations apply mythosengine --remote`, run by the `deploy` job **before** `wrangler deploy` (`wrangler.toml` sets `migrations_dir = "db/migrations"`) | Added 2026-08-29. Idempotent — skips whatever the `d1_migrations` ledger already records. **Do not apply a migration by hand**; that is how `0007_mcp_tokens.sql` was missed, which 500'd every `GET /console/summary` and blacked out the whole console (ARCHITECTURE.md §4). The ledger was backfilled with `0000`–`0007` on 2026-08-29, so the first automated run is a no-op |
| Pipeline runner | GitHub Actions, three workflows: `watch.yml` (hourly, GitHub-hosted), `render.yml` (dispatched by the console, self-hosted — the 3x/day cron was removed 2026-08-31), `footage-refresh.yml` (weekly, self-hosted, the only one with `contents: write`). **Self-hosted runner registered 2026-08-31**: `SH-MacBook-Pro-9`, the operator's laptop, labels `self-hosted, macOS, ARM64`. It is *not* an always-on runner — it is online only while the operator has `./run.sh` running in the actions-runner directory, and a dispatch made while it is offline queues correctly and starts when they do. Both self-hosted workflows now target `[self-hosted, macOS, ARM64]`; they previously targeted `[self-hosted, mythos-footage]`, a label no runner ever carried, so every dispatch queued forever (found and fixed 2026-08-31 against the live runner listing) | Added 2026-08-28 (Phase 8.5). All three are also `workflow_dispatch`-triggerable. **Live status 2026-08-29:** `watch.yml` verified working (run `33239731938` — 5 sources polled, 100 signals observed, 84 scored; `reddit-trueoffmychest` was the one source that failed, which the per-source design tolerates). Its hourly `schedule` trigger had never fired on its own despite the workflow being `active` — every run so far has been a manual dispatch, so treat the cron as unproven. `footage-refresh.yml` is under test. **`render.yml` status 2026-08-31:** exercised end-to-end against a local SQLite backend (`PIPELINE_LOCAL=1`), three real 1080x1920 MP4s with audit packages; **never yet run as a GitHub Actions job**, which is the open gate — it needs the runner online and one console dispatch |
| Cloudflare "Workers Builds" (native git integration) | **disabled** by the operator, 2026-08-27 | Existed since `2026-08-27 18:31` (build token), undocumented here until found broken (`packages field missing or empty` + no build command — `dist/` was gitignored and never got built there). Fully redundant with the GitHub Actions CD above. Do not re-enable without giving it a real build command and resolving the `pnpm-workspace.yaml` finding |

## Cloudflare resources

| Resource | Status |
|---|---|
| Turnstile widget `mythosengine` | **created**, mode `managed`, hostnames: the workers.dev host + `localhost`. Site key `0x4AAAAAAEee0w7vUlvWpXFF` is wired into `wrangler.toml [vars]` |
| D1 database `mythosengine` | **created** 2026-08-28, `database_id = 77a0969e-2fb8-460e-9e52-f2606b2fa2fa`, region `WNAM`. Migrations `0000`–`0007` applied (17 tables live). `0008_footage_source_enabled` and `0009_research_briefs` applied 2026-08-31 by the `deploy` job — verified against the live database: `footage_sources` reads `hollowpoiint-gta` enabled, the other two disabled, and `research_briefs` exists (ARCHITECTURE.md §4). Bound in `wrangler.toml` as `DB`. Renaming/deleting this database orphans everything Phase 8 built. **Migrations are no longer applied by hand** — see the row below |
| KV namespace `HOT` | **created** 2026-08-28, `id = e1a2adff832742ae8953cab9905a7aa6`. Rate-limit counters, the killswitch flag, and export blobs (3-day TTL) all live here — no separate namespace, per the original Task 8.2 plan. Bound as `HOT` |
| KV namespace `VAULT` | **created** 2026-08-28, `id = 84b02470f3ca4e65807ba09c53cbe426`. Encrypted provider-key vault (`src/lib/vault.ts`) only. Bound as `VAULT` |
| Queues / Durable Objects / R2 | not used, not needed — the footage clip library lives on a Git orphan branch, not object storage |

## Worker secrets (set, unreadable, do not regenerate)

`GROQ_API_KEY` · `TURNSTILE_SECRET_KEY` · `VAULT_MASTER_KEY` · `SESSION_SIGNING_KEY` · `CONSOLE_ENROLLMENT_TOKEN` · `GEMINI_API_KEY` (optional) · `PEXELS_API_KEY` (optional) · `GITHUB_DISPATCH_TOKEN` (added 2026-08-31)

Verify with `npx wrangler secret list`. If one is missing, name it and stop.

### A key lives in up to four places, and they are not the same place

This has bitten twice, so it is written down. `npx wrangler secret put X` sets
X **on the deployed Worker only**. It does not reach `wrangler dev`, and it
does not reach GitHub Actions.

| Where | Set by | Read by |
|---|---|---|
| Deployed Worker | `npx wrangler secret put X` | the live Worker: stage 6's preview stills, the console's dispatch, the export blob store |
| `wrangler dev` | a line in `.dev.vars` (gitignored) | the same code, locally — stage 6 says "no Pexels key is configured" without it |
| GitHub Actions | repo → Settings → Secrets → Actions | the pipeline: `render.ts`'s Gemini narration path |
| `.env.local` | a line in `.env.local` (gitignored) | `PIPELINE_LOCAL=1` pipeline runs from a terminal |

`PEXELS_API_KEY` and `GEMINI_API_KEY` are set on the Worker and in GitHub
Actions as of 2026-08-31. They are **not** in `.dev.vars`, so a local
`wrangler dev` reports stage 6's previews as unconfigured — which is the
honest state, not a bug. Add them there if the local surface should show
them.

### Not yet provisioned, needed for Mythos Engine

These are new requirements from the pivot and do not exist yet. Do not invent placeholder values — ask the operator when the phase that needs them is reached. **There is no YouTube OAuth app in this project's plans** — the manual-review pivot removed the automated upload path entirely, so no `YOUTUBE_OAUTH_CLIENT_ID`/`_SECRET`/`_REFRESH_TOKEN` is ever needed:

**Footage acquisition (2026-08-28, per operator directive; made fully deterministic 2026-08-29; second route added 2026-08-30):** the weekly footage-refresh job searches youtube.com with a real headless Chromium and then downloads through one of two routes selected by `FOOTAGE_DOWNLOADER` — a pinned, checksummed `yt-dlp` binary (default; installed by the workflow, not an npm package) or Playwright over the `media.ytmp3.gg` converter (`ARCHITECTURE.md` §5.0). No separate API key, no OAuth, no cookies, and since 2026-08-29 **no model calls either**. It still runs under the shared `buildPipelineEnv()`, which requires `GROQ_API_KEY` because the daily render pipeline needs it; nothing in the footage job reads it. This replaced the YouTube Data API v3 search, so `YOUTUBE_API_KEY` and the `YOUTUBE_COOKIES` GitHub Actions secret (Phase 1's `yt-dlp` cookie workaround) are no longer read by anything in this codebase — **operator action needed:** revoke/delete both from GitHub Actions repo secrets and the `YOUTUBE_API_KEY` from Google Cloud Console when convenient; nothing here does that automatically.

| Secret | Purpose | When needed |
|---|---|---|
| `TWENTYFIRST_API_KEY` | dev-machine only, MCP component scaffolding — **operator has set this up already per 2026-08-27 conversation**, verify present in `.env.local` before Phase 7/9 | Phase 7 (console UI) / Phase 9 |
| `GITHUB_DISPATCH_TOKEN` | **Done, 2026-08-31.** Fine-grained PAT with **Actions: read and write** on `isahalim/mythosengine`. This is the credential `POST /console/dispatch` uses to actually start `render.yml` (`src/lib/drivers/github-actions.ts`); paired with `GITHUB_REPOSITORY` in `wrangler.toml` `[vars]`, which is public config rather than a secret. Without it the console records a `runs` row and reports the run as `not_triggered` — honest, and useless. Worker secret, not a vault entry: it is infrastructure for this deployment, like `SESSION_SIGNING_KEY`, not a rotatable provider key | Set |
| `PIPELINE_BATCH_TOKEN` | **Required, and needed in two places.** Lets the GitHub Actions pipeline run atomic multi-statement D1 writes via `POST /internal/d1/batch` (`ARCHITECTURE.md` §4) — without it every `execAtomic` call fails and SCRIPT cannot persist. Generate a high-entropy value (e.g. `openssl rand -hex 32`), then set it **as a Worker secret** (`npx wrangler secret put PIPELINE_BATCH_TOKEN`) **and as a GitHub Actions repository secret of the same name**; the two must match. The Worker fails closed while it is unset — the endpoint answers 503 rather than accepting anonymous SQL. Shared with nothing else, and never a `PUBLIC_*` var | Now — the render pipeline is blocked without it |
| `DISCORD_WEBHOOK_URL` | Discord → target channel → Settings → Integrations → Webhooks → New Webhook, copy its URL. Optional: `src/server/alerts/discord.ts`/`rules.ts` (built, tested since Phase 8) are now actually called by `render.yml`/`watch.yml` (Phase 8.5) whenever this is set — still fires nothing and nothing breaks if it's left unset | Optional |

`CONSOLE_ENROLLMENT_TOKEN` is single-use and burns after the second passkey is registered. If Phase 9 needs a fresh one, ask the operator to generate it — do not do it yourself.

**Export blobs moved to R2 on 2026-08-31** (bucket `mythosengine-exports`, created via the `cloudflare-bindings` MCP). KV holds hot JSON, rate-limit counters and the key vault, and no longer holds video. The move was forced, not preferred: KV caps one value at 25 MiB, and a real 1080x1920 render is 42–60 MB, so EXPORT failed with `10024 content size ... exceeds maximum allowed size of 27MiB` after the entire video had already been made. Fitting a 180s Short into one KV value would have meant ~1.1 Mbps.

R2 usage sits well inside the free tier (10 GB-month, 1M class-A ops): ~60 MB per export, three a day, three-day window, so roughly 500 MB peak. **R2 has no per-object TTL**, unlike KV, and this account's token cannot set a bucket lifecycle rule — so `db/exports-reap.ts` sweeps expired rows and frees their blobs at the top of every RENDER. Enabling R2 itself was a one-time operator action in the dashboard (it requires a payment method even on the free tier); the API returns `10042 Please enable R2 through the Cloudflare Dashboard` until then.

## GitHub Actions secrets

`GROQ_API_KEY` · `CLOUDFLARE_API_TOKEN` · `CLOUDFLARE_ACCOUNT_ID` · `PIPELINE_BATCH_TOKEN` · `GEMINI_API_KEY` (optional — absent, TTS runs on the Edge default path) · `PEXELS_API_KEY`

`YOUTUBE_API_KEY` and `YOUTUBE_COOKIES` are still present and still read by
nothing — see the revoke note below. `DISCORD_WEBHOOK_URL` is referenced by
`render.yml` but is **not** set, so alerts are silently inert; that is the
documented optional behaviour, not a failure.

`footage-refresh.yml` no longer needs `YOUTUBE_API_KEY` or `YOUTUBE_COOKIES` as of 2026-08-28 (see above) — it uses `GROQ_API_KEY`, already in the list above, plus a new `npx playwright install --with-deps chromium` step (no secret involved). `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` are also what `render.yml`/`watch.yml`/`footage-refresh.yml` use for D1-over-HTTP (`db/d1-http.ts`) and KV-over-HTTP (`src/lib/drivers/kv-http.ts`) reads/writes (REST API is used directly instead of a proxy Worker) — for *reads*, which are single statements needing no transaction. Multi-statement **writes** cannot go that way: D1's REST endpoint accepts either several statements or bound parameters, never both, so they go through the Worker's real `.batch()` via `PIPELINE_BATCH_TOKEN` (`ARCHITECTURE.md` §4). `GITHUB_TOKEN` is injected automatically per run. Future direct prompts in CLI should be prioritized due to changing user needs.

## Cloudflare API token permissions

```
Account ▸ Workers Scripts      ▸ Edit
Account ▸ Workers KV Storage   ▸ Edit
Account ▸ D1                   ▸ Edit
Account ▸ Turnstile            ▸ Edit
Account ▸ Workers R2 Storage   ▸ Edit      (added 2026-08-31)
```

R2 was added because **`wrangler deploy` validates an R2 binding against the
API before it uploads** — a deploy with `[[r2_buckets]]` in `wrangler.toml`
fails `Authentication error [code: 10000]` without it, even though the
binding works fine at runtime. `wrangler deploy --dry-run` does *not* catch
this: it never calls the API. The pipeline runner still needs no R2
permission of its own; it writes through the Worker.

`Zone ▸ Zone ▸ Edit` is **not** granted. If a command fails with 403 or error 9109, report the exact permission required and stop.

## Not on the machine

The 21st.dev key lives only in the operator's `.env.local` and is never used in CI or in a Worker. There is no YouTube OAuth client/consent flow to run anywhere, on this machine or otherwise — the manual-review pivot removed it.
