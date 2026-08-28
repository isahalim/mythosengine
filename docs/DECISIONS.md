# Decisions — append-only ADR log

Never edit or delete an entry. Append a new one if a decision changes.

---

## 2026-08-27 — Phase 0/1 skeleton: repo now matches PROVISIONED.md, minimal homepage live

**What changed:**
- Restored `wrangler.toml` with an `[assets]` block (`directory = "./dist"`, `binding = "ASSETS"`) and rewrote `src/index.ts` to handle `/healthz` (200), `/readyz` (503 — honest, since D1/KV don't exist yet), and fall through to `env.ASSETS` for everything else.
- Scaffolded Astro (static output, no adapter — the Worker's `[assets]` binding serves `dist/` directly) + TypeScript strict + Tailwind v4 (CSS-first config via `@tailwindcss/vite`, not the older `@astrojs/tailwind` integration).
- Added `tokens.css` with the "wet slate" palette from `ARCHITECTURE.md` §8, self-hosted Fontsource fonts (Bricolage Grotesque / Public Sans / JetBrains Mono).
- Built a real homepage (`src/pages/index.astro`): hero copy, a static SVG "bead" as the tier-1 hero fallback (the full WebGL shader is explicitly Phase 7 scope, not attempted here), and a provenance-strip preview using the two chip states.
- Wrote `pnpm verify` (`scripts/verify.mjs`) as a real, currently-partial gate: `tsc --noEmit`, `eslint --max-warnings 0`, `gitleaks detect` (working tree via `--no-git`, and full history), `astro build`, `scripts/scan-bundle-for-secrets.mjs` (written now, greps `dist/` for values pulled from local env files plus a high-entropy heuristic), `vitest run`. All six currently pass.
- Deployed the build to the live Worker (`mythosengine.5ryfrrjgmg.workers.dev`) after explicit confirmation, since deploying to a live endpoint is an action the harness correctly gates on user approval.

**Why:**
- `PROVISIONED.md` claimed the stub already had the assets block, the `/healthz`+`ASSETS` fallback, and `TURNSTILE_SITE_KEY` in `wrangler.toml [vars]`. None of that was actually on `main` (git history shows a commit titled that way, but its content isn't present at HEAD — likely reverted/squashed). Verified live against Cloudflare (`wrangler secret list`, `d1 list`, `kv namespace list`) that the *resource*-level claims in `PROVISIONED.md` are accurate; it was specifically the file-content claims that were stale.
- The user asked for a visible MVP webpage as fast as responsibly possible, explicitly overriding the normal one-phase-per-session gating in `AGENT_PLAYBOOK.md` for this session.

**What was rejected:**
- `typescript@7.0.2` (latest on npm) — rejected in favor of `typescript@^5.9.3`. Verified via `pnpm peers check` that `typescript-eslint@8.68.0`'s peer range is `>=4.8.4 <6.1.0`; TS 7 fails that range. Not guessed — observed directly from a failed peer resolution.
- Wiring `TURNSTILE_SITE_KEY` into `wrangler.toml [vars]` — not attempted. Couldn't independently verify the widget or obtain the actual site-key value in this session (see the Task 0.1 report in-conversation). Fabricating one would silently produce a broken Turnstile widget later. Left for the operator to supply, or for a session with proper Turnstile-scoped API read access.
- The full WebGL hero (§8) — out of scope for this session; a static SVG poster (tier 1 of the documented 3-tier progressive enhancement) stands in for it. Building tiers 2/3 is Phase 7 work.
- `semgrep`, `osv-scanner`, `knip`, `size-limit`, `scripts/verify-quotas.mjs` — not wired into `pnpm verify` yet. `semgrep`/`osv-scanner` aren't installed in this environment; the other three need more of the pipeline/hero to exist before they're meaningful. `scripts/verify.mjs` prints this list on every run so the gap stays visible rather than silently passing as if the gate were complete.
