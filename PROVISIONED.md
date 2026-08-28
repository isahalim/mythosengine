# PROVISIONED — what already exists

Read before running any provisioning command. Everything here was created by the operator by hand, or by an earlier agent session under the operator's approval. **Do not recreate, rename, or regenerate any of it.**

Last updated: `2026-08-28`

> This infrastructure was originally provisioned for "MythosEngine" and carries over unchanged into the AutoShorts AI pivot (same Worker, same secrets, same Turnstile widget) — only the product built on top of it changed. See `docs/DECISIONS.md`.

## Deployment

| Thing | Value | Notes |
|---|---|---|
| Worker name | `mythosengine` | pinned in `wrangler.toml`. Renaming orphans every secret below. Kept as the technical/internal name; the product is branded AutoShorts AI in the console UI only |
| Live URL | `https://mythosengine.5ryfrrjgmg.workers.dev` | serving the AutoShorts AI status page |
| Hosting model | Worker with static assets (`[assets] directory = "./dist"`) | **not** Cloudflare Pages |
| Custom domain | not registered | operator will handle |
| Entry point | `src/index.ts` | `/healthz`, `/readyz` (probes the real D1 + KV bindings as of 2026-08-28), `/auth/*` and `/console/*` routed by `src/server/router.ts` (Phase 8), falls through to `env.ASSETS` for everything else |
| CD | GitHub Actions (`.github/workflows/ci.yml`, `deploy` job) — push to `main`, gated on `verify` passing | See `docs/DECISIONS.md` (2026-08-27, "CD added") |
| Cloudflare "Workers Builds" (native git integration) | **disabled** by the operator, 2026-08-27 | Existed since `2026-08-27 18:31` (build token), undocumented here until found broken (`packages field missing or empty` + no build command — `dist/` was gitignored and never got built there). Fully redundant with the GitHub Actions CD above. Do not re-enable without giving it a real build command and resolving the `pnpm-workspace.yaml` finding recorded in `docs/DECISIONS.md` |

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

### Not yet provisioned, needed for AutoShorts AI

These are new requirements from the pivot and do not exist yet. Do not invent placeholder values — ask the operator when the phase that needs them is reached. **There is no YouTube OAuth app in this project's plans** — the manual-review pivot (see `docs/DECISIONS.md`) removed the automated upload path entirely, so no `YOUTUBE_OAUTH_CLIENT_ID`/`_SECRET`/`_REFRESH_TOKEN` is ever needed:

| Secret | Purpose | When needed |
|---|---|---|
| `YOUTUBE_API_KEY` | Read-only Data API key (Google Cloud Console → Credentials → Create API Key, restricted to the YouTube Data API v3), used only for `channels.list`/`search.list`/`videos.list` (public read-only data: resolving `@handle` → channel id, finding a channel's top videos). Used by `src/lib/drivers/youtube-search.ts` (built, contract-tested; no real key available in that session — see docs/DECISIONS.md) | Phase 5 (footage discovery), Phase 8 (provisioning) |
| `TWENTYFIRST_API_KEY` | dev-machine only, MCP component scaffolding — **operator has set this up already per 2026-08-27 conversation**, verify present in `.env.local` before Phase 7/9 | Phase 7 (console UI) / Phase 9 |
| `DISCORD_WEBHOOK_URL` | Discord → target channel → Settings → Integrations → Webhooks → New Webhook, copy its URL. Optional: `src/server/alerts/discord.ts`/`rules.ts` (built, tested) fire nothing and nothing breaks if this is unset — no caller invokes them yet either way (see docs/DECISIONS.md's Phase 8 entry) | Whichever future session builds the WATCH→EXPORT runner these alerts are meant to fire from |

`CONSOLE_ENROLLMENT_TOKEN` is single-use and burns after the second passkey is registered. If Phase 9 needs a fresh one, ask the operator to generate it — do not do it yourself.

The KV namespace provisioned in Phase 8 (Task 8.2) now also stores export blobs (rendered MP4s, 3-day TTL), not just hot JSON/rate-limit counters/the key vault — no separate namespace needed, but size this into the 1GB free-tier ceiling when checking headroom.

## GitHub Actions secrets

`GROQ_API_KEY` · `CLOUDFLARE_API_TOKEN` · `CLOUDFLARE_ACCOUNT_ID`

Will additionally need `YOUTUBE_API_KEY` (see above) once Phase 5/8 wire real footage-source discovery into a scheduled run. `CLOUDFLARE_API_TOKEN` is also what Phase 6's render job uses to write export blobs into KV. `GITHUB_TOKEN` is injected automatically per run.

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
