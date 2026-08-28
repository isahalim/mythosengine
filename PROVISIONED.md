# PROVISIONED — what already exists

Read before running any provisioning command. Everything here was created by the operator by hand, or by an earlier agent session under the operator's approval. **Do not recreate, rename, or regenerate any of it.**

Last updated: `2026-08-27`

> This infrastructure was originally provisioned for "MythosEngine" and carries over unchanged into the AutoShorts AI pivot (same Worker, same secrets, same Turnstile widget) — only the product built on top of it changed. See `docs/DECISIONS.md`.

## Deployment

| Thing | Value | Notes |
|---|---|---|
| Worker name | `mythosengine` | pinned in `wrangler.toml`. Renaming orphans every secret below. Kept as the technical/internal name; the product is branded AutoShorts AI in the console UI only |
| Live URL | `https://mythosengine.5ryfrrjgmg.workers.dev` | serving the AutoShorts AI status page |
| Hosting model | Worker with static assets (`[assets] directory = "./dist"`) | **not** Cloudflare Pages |
| Custom domain | not registered | operator will handle |
| Entry point | `src/index.ts` | `/healthz`, `/readyz` (503 until D1/KV exist), falls through to `env.ASSETS` |

## Cloudflare resources

| Resource | Status |
|---|---|
| Turnstile widget `mythosengine` | **created**, mode `managed`, hostnames: the workers.dev host + `localhost`. Site key `0x4AAAAAAEee0w7vUlvWpXFF` is wired into `wrangler.toml [vars]` |
| D1 database | **not created** — Task 8.2 |
| KV namespaces `HOT`, `VAULT` | **not created** — Task 8.2 |
| Queues / Durable Objects / R2 | not used, not needed — the footage clip library lives on a Git orphan branch, not object storage |

## Worker secrets (set, unreadable, do not regenerate)

`GROQ_API_KEY` · `TURNSTILE_SECRET_KEY` · `VAULT_MASTER_KEY` · `SESSION_SIGNING_KEY` · `CONSOLE_ENROLLMENT_TOKEN`

Verify with `npx wrangler secret list`. If one is missing, name it and stop.

### Not yet provisioned, needed for AutoShorts AI

These are new requirements from the pivot and do not exist yet. Do not invent placeholder values — ask the operator when the phase that needs them is reached:

| Secret | Purpose | When needed |
|---|---|---|
| `YOUTUBE_OAUTH_CLIENT_ID` / `YOUTUBE_OAUTH_CLIENT_SECRET` | YouTube Data API v3 OAuth app credentials (Google Cloud Console) | Phase 6 (upload) |
| `YOUTUBE_OAUTH_REFRESH_TOKEN` | Long-lived refresh token for the channel owner's account, obtained via a one-time consent flow | Phase 6 (upload) |
| `TWENTYFIRST_API_KEY` | dev-machine only, MCP component scaffolding — **operator has set this up already per 2026-08-27 conversation**, verify present in `.env.local` before Phase 7/9 | Phase 7 (console UI) / Phase 9 |

`CONSOLE_ENROLLMENT_TOKEN` is single-use and burns after the second passkey is registered. If Phase 9 needs a fresh one, ask the operator to generate it — do not do it yourself.

## GitHub Actions secrets

`GROQ_API_KEY` · `CLOUDFLARE_API_TOKEN` · `CLOUDFLARE_ACCOUNT_ID`

Will additionally need `YOUTUBE_OAUTH_*` (see above) once Phase 6 needs to upload from a scheduled run, not just via the console's dispatch. `GITHUB_TOKEN` is injected automatically per run.

## Cloudflare API token permissions

```
Account ▸ Workers Scripts      ▸ Edit
Account ▸ Workers KV Storage   ▸ Edit
Account ▸ D1                   ▸ Edit
Account ▸ Turnstile            ▸ Edit
```

`Zone ▸ Zone ▸ Edit` is **not** granted. If a command fails with 403 or error 9109, report the exact permission required and stop.

## Not on the machine

The 21st.dev key lives only in the operator's `.env.local` and is never used in CI or in a Worker. Same for the eventual YouTube OAuth client secret used for the one-time local consent flow to mint the refresh token — that flow runs on the operator's machine, never in CI.
