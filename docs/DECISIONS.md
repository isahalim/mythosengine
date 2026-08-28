# Decisions — append-only ADR log

Never edit or delete an entry. Append a new one if a decision changes.

---

## 2026-08-27 (later) — Full verify gate wired; Phase 1 driver layer

**What changed:**
- Wired `TURNSTILE_SITE_KEY` (`0x4AAAAAAEee0w7vUlvWpXFF`, confirmed live in the Cloudflare dashboard) into `wrangler.toml [vars]`.
- Installed `semgrep` and `osv-scanner` (Homebrew) and added `knip`, `size-limit`, `@vitest/coverage-v8` as dependencies. `scripts/verify.mjs` now runs the complete `AGENT_PLAYBOOK.md` Task 0.3 gate in order: tsc, eslint, gitleaks (tree + history), semgrep (OWASP + TS rulesets), osv-scanner + `pnpm audit`, knip, build, vitest with an enforced 80% branch/line/statement/function coverage threshold on `src/lib/**`, size-limit, and the bundle secret scanner. `verify-quotas.mjs` runs last and warns (never fails) on drift between `src/config/quotas.ts` and `ARCHITECTURE.md`. Added `.github/workflows/ci.yml` running the same gate on push/PR, with every third-party Action pinned to a commit SHA (semgrep's `github-actions-mutable-action-tag` rule caught the initial `@v4` tags — fixed, not suppressed).
- Only one gate item remains structurally unenforceable right now: size-limit's hero-island JS budget, because no hero/islands exist yet (Phase 7). `scripts/verify.mjs` prints this every run.
- Built Phase 1 (`AGENT_PLAYBOOK.md` "Skeleton and drivers"): `src/lib/result.ts` (`Result<T,E>`), `src/lib/drivers/types.ts` (all five driver interfaces from ARCHITECTURE.md §3), `config/providers.ts` (`resolveProviderConfig`, the only file that names vendors), `profiles/free.env`.
- Fully implemented and driver-contract-tested: `GroqLlmDriver`, `GroqWhisperDriver`, `YtCaptionsDriver`, `MemoryCacheDriver`, `KvCacheDriver`, and a shared `TokenBucketLimiter` (dual req/min + tokens/min bucket, FIFO-queued so concurrent `acquire()` calls serialize) and `fetchWithRetry` (hard timeout, bounded retries with jitter, retries only 429/5xx/network, honors `Retry-After`).

**Why:**
- The user asked to complete the full verify gate and continue into the next build phases in this session.
- `LocalMinilmEmbedDriver` and `SqliteVecVectorDriver` are typed stubs that always return a `not_implemented` `DriverError` — never a fake success — rather than rushed implementations. Real ones need `transformers.js` model weights and a loadable sqlite-vec extension, and are only meaningful once Phase 4's recall@8 eval set exists to test them against; building them blind now would be exactly the "half-finished implementation" this project's own rules warn against.

**What was rejected:**
- A live smoke-test call to the real Groq API — `GROQ_API_KEY` lives only in `.env.local`/GitHub Actions secrets, not in this shell's environment, and the driver-contract suite against a local mock HTTP server already exercises every documented failure mode (429 exhaustion, timeout, malformed JSON, empty/shape-mismatched response, non-retryable 4xx) without spending real quota.
- Two coverage-tool `/* v8 ignore */` pragmas (`http.ts`'s final unreachable return; `rate-limiter.ts`'s defensive rejection handler on an internal function that never rejects) — added only where the code is genuinely unreachable through the public API, not to hide an untested real path. No `eslint-disable` or `@ts-ignore` was used anywhere in this change.

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
