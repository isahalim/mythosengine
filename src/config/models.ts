/**
 * Which model answers a reasoning stage. One file, one answer.
 *
 * **Every reasoning stage and every tool loop runs on Groq
 * `openai/gpt-oss-120b`** — RESEARCH, retrieval reranking, SCRIPT, CRITIC,
 * PLAN and EDIT (operator direction, 2026-09-01, reverting the Gemini split
 * made earlier the same day).
 *
 * *Why the revert.* The Gemini free tier meters 5 requests/minute per text
 * model, and a single render spends six on RESEARCH's tool loop alone. The
 * first live run peaked at 6/5 RPM on `gemini-3.7-flash` and the render
 * failed at SCRIPT: the Groq fallback only fired on quota exhaustion, and
 * the run also drew two `500 InternalServerError`s, which is not
 * exhaustion. A per-minute ceiling a normal render cannot stay under is a
 * dependency, not an upgrade.
 *
 * *Why 120b and not the 20b model.* RESEARCH and PLAN previously ran on
 * `openai/gpt-oss-20b` to keep their tokens out of the 120b model's
 * separate daily budget. The operator's direction is explicit that the
 * smaller model is not to be used, so that split is gone and the whole
 * reasoning path shares one 200K token/day allowance
 * (`QUOTAS.groq.tokensPerDayGptOss`). The measured cost of a render is
 * ~15-25K tokens for RESEARCH plus a few thousand each for the rest, so
 * three renders a day sit inside it — but with less headroom than the
 * two-model split had, which is why `scripts/verify-quotas.mjs` and the
 * per-day figure in ARCHITECTURE.md §0 are worth watching.
 *
 * CRITIC shares this model with SCRIPT, which is a known compromise rather
 * than an oversight: a critic on the writer's own model is grading its own
 * work, and the second opinion is now a second *prompt*, not a second
 * model. It was the arrangement that shipped every video before
 * 2026-09-01.
 */
export const GROQ_REASONING_MODEL = "openai/gpt-oss-120b";
