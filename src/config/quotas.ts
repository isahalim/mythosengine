/**
 * Hard-coded free-tier limits this project budgets against.
 * Source of truth: ARCHITECTURE.md §0 and §9. `scripts/verify-quotas.mjs`
 * checks these against that doc on every `pnpm verify` run and warns on
 * drift — it does not fail the build, since a quota changing upstream is
 * not this repo's bug.
 */
export const QUOTAS = {
  groq: {
    requestsPerMinute: 30,
    // Corrected 2026-08-29 from 6000, against Groq's own dashboard for this
    // account (openai/gpt-oss-120b, free tier), which plots the limit line
    // at 8K and returns `rate_limit_exceeded` above it. This is the
    // binding constraint on this tier: observed traffic peaked at ~6
    // req/min (of 30) while crossing 8K tokens/min repeatedly.
    tokensPerMinute: 8000,
    requestsPerDay: 14400,
    /**
     * Tokens per day, per model — **the constraint that actually binds this
     * project**, and the one nothing tracked until 2026-08-29. A footage
     * run measured at ~185K tokens against gpt-oss-120b's 200K TPD, so a
     * single run could exhaust the day while the per-minute dashboard still
     * read 0% consumed. That is why the browser agent moved to
     * qwen/qwen3.8-27b: same 30 RPM and 8K TPM, ten times the daily budget.
     * Limits are per-model, so spreading work across models spreads the
     * daily allowance too.
     */
    tokensPerDayGptOss: 200_000,
    tokensPerDayQwen3: 2_000_000,
  },
  githubActions: {
    minutesPerMonthPrivate: 2000,
  },
  cloudflareD1: {
    storageGb: 5,
    rowReadsPerDay: 5_000_000,
  },
  cloudflareKv: {
    storageGb: 1,
    readsPerDay: 100_000,
    writesPerDay: 1000,
  },
} as const;
