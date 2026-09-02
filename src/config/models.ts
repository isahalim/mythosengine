/**
 * Which model answers a reasoning stage. One file, one answer.
 *
 * **Groq `openai/gpt-oss-120b` answers every reasoning stage and every tool
 * loop** — retrieval reranking, SCRIPT, CRITIC, PLAN and EDIT, plus
 * RESEARCH whenever the Gemini attempt below does not land (operator
 * direction, 2026-09-01, reverting the Gemini split made earlier the same
 * day).
 *
 * **The single exception is RESEARCH's first attempt**, which goes to
 * `GEMINI_RESEARCH_MODEL` (operator direction, 2026-09-02) and falls back
 * here on any failure. The narrowness is the point: see that constant for
 * why one intake-bound stage is worth a second provider and the other five
 * stages are not.
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

/**
 * RESEARCH's **first** attempt, and the only Gemini text model this system
 * names (operator direction, 2026-09-02).
 *
 * *Why RESEARCH and nothing else.* RESEARCH is the one reasoning stage
 * whose output quality is bounded by how much source material it can hold
 * at once. On Groq it must fit an entire growing tool conversation inside a
 * 7,200-token per-request ceiling, and `fitToRequestBudget` gets there by
 * throwing away tool results the model already went and fetched — a
 * measurably weaker brief, recorded as `toolResultsDropped`. Gemini's
 * intake is large enough that nothing has to be dropped, which is the whole
 * of the operator's stated reason. SCRIPT, CRITIC, PLAN, EDIT and reranking
 * are not intake-bound and stay on `GROQ_REASONING_MODEL`.
 *
 * *Why exactly four turns.* The free tier meters 5 requests/minute per
 * model. RESEARCH's full loop is six, which is what took the render down on
 * 2026-09-01. Four is under the ceiling with headroom, so the attempt never
 * waits on a limiter and never meets a 429 — and four turns holding whole
 * articles do more work than six holding truncations.
 *
 * *Why no ladder.* Descending to 3.6 Flash for the remaining turns would
 * buy a separate per-model bucket, and the operator considered it on
 * 2026-09-02. It was declined: Gemini's tool transcripts carry signed
 * `thought` steps, whether a second model accepts the first's signatures is
 * untested, and the failure is a bare `invalid_request` that would only
 * appear live. Groq is the fallback instead, because Groq is known to work.
 *
 * The fallback fires on **any** failure, which is the correction to the
 * deleted `withGroqFallback`: it fell back only on quota exhaustion, so the
 * two `500 InternalServerError`s the 2026-09-01 run drew went straight to
 * the floor. See `src/lib/rag/research-provider.ts`.
 */
export const GEMINI_RESEARCH_MODEL = "gemini-3.7-flash";

/**
 * Turns the Gemini attempt may spend, against a 5 requests/minute ceiling.
 * See `GEMINI_RESEARCH_MODEL`. The Groq fallback keeps RESEARCH's full
 * six — it is paced by a token bucket, not by a per-minute request count.
 */
export const GEMINI_RESEARCH_MAX_ITERATIONS = 4;
