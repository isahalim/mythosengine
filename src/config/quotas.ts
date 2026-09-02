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
     * read 0% consumed. The browser agent moved to qwen/qwen3.8-27b for
     * that reason (same 30 RPM and 8K TPM, ten times the daily budget) and
     * was then deleted outright on 2026-08-29: both footage legs are plain
     * code now, so FOOTAGE REFRESH spends no tokens whatsoever and the
     * whole 200K gpt-oss budget belongs to SCRIPT/CRITIC/metadata again.
     * Limits are per-model, so spreading work across models would spread
     * the daily allowance too — and this project deliberately does not.
     * RESEARCH ran on gpt-oss-20b for that reason from 2026-08-30 until the
     * operator's direction of 2026-09-01 put every reasoning stage on
     * gpt-oss-120b (src/config/models.ts). So this one 200K/day is now the
     * whole reasoning budget, and RESEARCH is the stage that eats it: its
     * cost scales with how hard it works (up to 6 tool iterations, each
     * re-sending the conversation plus tool schemas, plus up to 6K
     * characters per source read — ~15-25K tokens per render, ~75K/day for
     * three). Three renders a day fit; a day of re-runs might not, and the
     * symptom would be a late render failing at SCRIPT rather than
     * anything named "quota".
     */
    tokensPerDayGptOss: 200_000,
    tokensPerDayQwen3: 2_000_000,
  },
  /**
   * Gemini free tier, from the operator's own AI Studio rate-limit export
   * for project *Mythos Engine* (28-day window), 2026-08-31 — measured, not
   * assumed from a pricing page.
   *
   * **10 requests per day is the binding limit**, and it is per day, not per
   * run. It is what forces one TTS call per video (plan v2 §4) and rules out
   * per-beat synthesis entirely: a 20-beat video synthesized beat-by-beat
   * would be twice the entire daily budget. It is also why Edge TTS is the
   * default path and this is only the upgrade — on any day with more than a
   * few videos, or any day that burns retries, Edge is the path.
   *
   * Pro TTS is not on the free tier at all (0/0/0 in the same export), so
   * the expressiveness argument for leaving Edge rests on Flash TTS.
   *
   * `tokensPerMinute` is **unverified against a full-length request** (plan
   * v2 §9): output audio tokens count toward it, and the format asks for up
   * to 180s of speech in one call. Nothing here has measured whether that
   * fits.
   */
  gemini: {
    /**
     * The **text** models' free-tier limits, read off the operator's own AI
     * Studio rate-limit page on 2026-09-01 — measured, not taken from a
     * pricing page. Deleted with the reasoning split later that day and
     * restored on 2026-09-02, when RESEARCH's first attempt went back to
     * Gemini (src/lib/rag/research-provider.ts). Something budgets against
     * them again, which is the only reason they are here.
     *
     * **5 requests per minute** is the number that ended the 2026-09-01
     * experiment: RESEARCH's tool loop can spend six, and the first live
     * run peaked at 6/5 on gemini-3.7-flash and lost the render. It is also
     * why the Gemini attempt is capped at four turns
     * (`GEMINI_RESEARCH_MAX_ITERATIONS`) rather than paced up against the
     * ceiling — four requests never reach the limit, so there is nothing to
     * wait for and nothing to lose a render to. The limiter built from this
     * number is a guard against two renders inside one minute, not the
     * mechanism that keeps a single render legal.
     *
     * The limits are per model, which is what a ladder would have exploited.
     * There is deliberately no ladder: descending one mid-tool-loop would
     * hand the next model the previous model's signed `thought` steps, and
     * whether that is accepted is untested (operator decision, 2026-09-02).
     * Groq is the fallback instead, and it is known to work.
     */
    textRequestsPerMinute: 5,
    textTokensPerDay: 250_000,
    ttsRequestsPerMinute: 3,
    ttsTokensPerMinute: 10_000,
    ttsRequestsPerDay: 10,
    /**
     * How many of the ten this pipeline will spend before falling back to
     * Edge. Two held back: a render that fails after synthesis (FFmpeg,
     * export) is re-run by the operator, and arriving at that re-run with a
     * budget of zero would silently downgrade the retry's narration.
     */
    ttsRequestsPerDayBudget: 8,
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
