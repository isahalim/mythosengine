# PROVISIONED — what already exists

Read before running any provisioning command. Everything here was created by the operator by hand. **Do not recreate, rename, or regenerate any of it.** Fill in the bracketed values before handing this file to the agent.

Last updated: `[DATE]`

## Deployment

| Thing | Value | Notes |
|---|---|---|
| Worker name | `mythosengine` | pinned in `wrangler.toml`. Renaming orphans every secret below |
| Live URL | `https://mythosengine.5ryfrrjgmg.workers.dev` | serving a placeholder page |
| Hosting model | Worker with static assets (`[assets] directory = "./public"`) | **not** Cloudflare Pages. Do not create a Pages project |
| Custom domain | not registered | `mythosengine.dev` is a paid registration the operator will handle |
| Entry point | `src/index.ts` | stub: `/healthz` returns ok, everything else falls through to `env.ASSETS` |

## Cloudflare resources

| Resource | Status |
|---|---|
| Turnstile widget `mythosengine` | **created**, mode `managed`, hostnames: the workers.dev host + `localhost` |
| Turnstile site key | in `wrangler.toml` under `[vars] TURNSTILE_SITE_KEY` — public by design |
| D1 database | **not created** — Task 8.2 |
| KV namespaces `HOT`, `VAULT` | **not created** — Task 8.2 |
| Queues / Durable Objects / R2 | not used, not needed |

## Worker secrets (set, unreadable, do not regenerate)

`GROQ_API_KEY` · `TURNSTILE_SECRET_KEY` · `VAULT_MASTER_KEY` · `SESSION_SIGNING_KEY` · `CONSOLE_ENROLLMENT_TOKEN`

Verify with `npx wrangler secret list`. If one is missing, name it and stop — do not invent a replacement, because the operator holds the only copy and a silent regeneration would break the console's key vault and every existing session.

`CONSOLE_ENROLLMENT_TOKEN` is single-use and burns after the second passkey is registered. If Phase 9 needs a fresh one, ask the operator to generate it — do not do it yourself.

## GitHub Actions secrets

`GROQ_API_KEY` · `CLOUDFLARE_API_TOKEN` · `CLOUDFLARE_ACCOUNT_ID`

`GITHUB_TOKEN` is injected automatically per run. Do not create one.

## Cloudflare API token permissions

```
Account ▸ Workers Scripts      ▸ Edit
Account ▸ Workers KV Storage   ▸ Edit
Account ▸ D1                   ▸ Edit
Account ▸ Turnstile            ▸ Edit
```

`Zone ▸ Zone ▸ Edit` is **not** granted — it is only needed once a custom domain exists. If a command fails with 403 or error 9109, report the exact permission required and stop.

## Not on the machine

The 21st.dev key lives only in the operator's `.env.local` and is never used in CI or in a Worker.
