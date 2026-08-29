# PROVISIONED — what already exists

Read before running any provisioning command. Everything here was created by the operator by hand, or by an earlier agent session under the operator's approval. **Do not recreate, rename, or regenerate any of it.**

Last updated: `2026-08-28`

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
| Pipeline runner | GitHub Actions, three workflows: `watch.yml` (hourly), `render.yml` (3x/day), `footage-refresh.yml` (weekly, the only one with `contents: write`) | Added 2026-08-28 (Phase 8.5). All three are also `workflow_dispatch`-triggerable; none has been run live yet |
| Cloudflare "Workers Builds" (native git integration) | **disabled** by the operator, 2026-08-27 | Existed since `2026-08-27 18:31` (build token), undocumented here until found broken (`packages field missing or empty` + no build command — `dist/` was gitignored and never got built there). Fully redundant with the GitHub Actions CD above. Do not re-enable without giving it a real build command and resolving the `pnpm-workspace.yaml` finding |

## Cloudflare resources

| Resource | Status |
|---|---|
| Turnstile widget `mythosengine` | **created**, mode `managed`, hostnames: the workers.dev host + `localhost`. Site key `0x4AAAAAAEee0w7vUlvWpXFF` is wired into `wrangler.toml [vars]` |
| D1 database `mythosengine` | **created** 2026-08-28, `database_id = 77a0969e-2fb8-460e-9e52-f2606b2fa2fa`, region `WNAM`. All 7 committed migrations (`db/migrations/0000`–`0006`) applied via `wrangler d1 execute --remote` — 16 tables live. Bound in `wrangler.toml` as `DB`. Renaming/deleting this database orphans everything Phase 8 built |
| KV namespace `HOT` | **created** 2026-08-28, `id = e1a2adff832742ae8953cab9905a7aa6`. Rate-limit counters, the killswitch flag, and export blobs (3-day TTL) all live here — no separate namespace, per the original Task 8.2 plan. Bound as `HOT` |
| KV namespace `VAULT` | **created** 2026-08-28, `id = 84b02470f3ca4e65807ba09c53cbe426`. Encrypted provider-key vault (`src/lib/vault.ts`) only. Bound as `VAULT` |
| Queues / Durable Objects / R2 | not used, not needed — the footage clip library lives on a Git orphan branch, not object storage |

## Worker secrets (set, unreadable, do not regenerate)

`GROQ_API_KEY` · `TURNSTILE_SECRET_KEY` · `VAULT_MASTER_KEY` · `SESSION_SIGNING_KEY` · `CONSOLE_ENROLLMENT_TOKEN`

Verify with `npx wrangler secret list`. If one is missing, name it and stop.

### Not yet provisioned, needed for Mythos Engine

These are new requirements from the pivot and do not exist yet. Do not invent placeholder values — ask the operator when the phase that needs them is reached. **There is no YouTube OAuth app in this project's plans** — the manual-review pivot removed the automated upload path entirely, so no `YOUTUBE_OAUTH_CLIENT_ID`/`_SECRET`/`_REFRESH_TOKEN` is ever needed:

- **Proposed Agentic Video Acquisition Plan:** Uses Groq API Cloud and MCP servers to search `("<game name>" walkthrough "<channel name>" youtube)`, copy top search link, navigate to `https://media.ytmp3.gg/tools/youtube-to-mp4-converter/dbismy` (ytmp3), paste link, convert to MP4, download, and feed into the pipeline.

| Secret | Purpose | When needed |
|---|---|---|
| `YOUTUBE_API_KEY` | Read-only Data API key (Google Cloud Console → Credentials → Create API Key, restricted to the YouTube Data API v3), used only for `channels.list`/`search.list`/`videos.list` (public read-only data: resolving `@handle` → channel id, finding a channel's top videos). Used by `src/lib/drivers/youtube-search.ts` (built, contract-tested; no real key available in that session) | `footage-refresh.yml` now actually reads this at runtime (Phase 8.5) and fails with a named error if it's unset — it is a hard blocker for that workflow, not just a future placeholder anymore |
| `TWENTYFIRST_API_KEY` | dev-machine only, MCP component scaffolding — **operator has set this up already per 2026-08-27 conversation**, verify present in `.env.local` before Phase 7/9 | Phase 7 (console UI) / Phase 9 |
| `DISCORD_WEBHOOK_URL` | Discord → target channel → Settings → Integrations → Webhooks → New Webhook, copy its URL. Optional: `src/server/alerts/discord.ts`/`rules.ts` (built, tested since Phase 8) are now actually called by `render.yml`/`watch.yml` (Phase 8.5) whenever this is set — still fires nothing and nothing breaks if it's left unset | Optional |

`CONSOLE_ENROLLMENT_TOKEN` is single-use and burns after the second passkey is registered. If Phase 9 needs a fresh one, ask the operator to generate it — do not do it yourself.

The KV namespace provisioned in Phase 8 (Task 8.2) now also stores export blobs (rendered MP4s, 3-day TTL), not just hot JSON/rate-limit counters/the key vault — no separate namespace needed, but size this into the 1GB free-tier ceiling when checking headroom.

## GitHub Actions secrets

`GROQ_API_KEY` · `CLOUDFLARE_API_TOKEN` · `CLOUDFLARE_ACCOUNT_ID`

Will additionally need `YOUTUBE_API_KEY` (see above) — `footage-refresh.yml` (Phase 8.5) requires it at runtime now, not just eventually. `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` are also what `render.yml`/`watch.yml`/`footage-refresh.yml` use for D1-over-HTTP (`db/d1-http.ts`) and KV-over-HTTP (`src/lib/drivers/kv-http.ts`) reads/writes (REST API is used directly instead of a proxy Worker). `GITHUB_TOKEN` is injected automatically per run. Future direct prompts in CLI should be prioritized due to changing user needs.

## Cloudflare API token permissions

```
Account ▸ Workers Scripts      ▸ Edit
Account ▸ Workers KV Storage   ▸ Edit
Account ▸ D1                   ▸ Edit
Account ▸ Turnstile            ▸ Edit
```

`Zone ▸ Zone ▸ Edit` is **not** granted. If a command fails with 403 or error 9109, report the exact permission required and stop.

## Not on the machine

The 21st.dev key lives only in the operator's `.env.local` and is never used in CI or in a Worker. There is no YouTube OAuth client/consent flow to run anywhere, on this machine or otherwise — the manual-review pivot removed it.
