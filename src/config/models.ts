/**
 * Which model answers a reasoning stage. One file, one answer.
 *
 * **Groq `openai/gpt-oss-120b` answers SCRIPT, PLAN, EDIT and RESEARCH's
 * fallback** (operator direction, 2026-09-01, reverting the Gemini split
 * made earlier the same day). Two stages have since moved off it —
 * see `GROQ_LIGHT_MODEL` — and one has stopped calling a model at all:
 * stage 4's Ideas list went back to plain BM25 on 2026-09-03 by operator
 * direction, so the Worker again makes no model call anywhere.
 * `rerankPassages` still reorders RESEARCH's retrieval inside the pipeline,
 * and that one is here.
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
 * *Why 120b and not the 20b model, for the stages still here.* Groq meters
 * tokens per model per day, so every stage left on this model competes for
 * one 200K allowance (`QUOTAS.groq.tokensPerDayGptOss`). Measured on the
 * 2026-09-02 render, what remains costs ~130K a render: EDIT ~90-110K
 * across ~34 tool turns, RESEARCH ~15-25K when it falls back here, and a
 * few thousand each for SCRIPT and PLAN. **That is two renders a day, not
 * three**, and EDIT is the whole reason. The fix is fewer tool turns or a
 * shorter `EDIT_TOOLS`, not a smaller model — moving EDIT was offered on
 * 2026-09-03 and declined, because a weaker model's tool-calling degrades
 * into "every clip as sourced" quietly. `scripts/verify-quotas.mjs` and the
 * per-day figure in ARCHITECTURE.md §0 are what watch this.
 *
 * CRITIC used to share this model with SCRIPT, which was a known compromise
 * rather than an oversight: a critic on the writer's own model is grading
 * its own work. It no longer does — see `GROQ_LIGHT_MODEL`.
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

/**
 * The lighter half of the reasoning path — **CRITIC and EXPORT's listing
 * only** (operator direction, 2026-09-03).
 *
 * *Why this model exists again.* It was deleted on 2026-09-01, when every
 * reasoning stage was consolidated onto `GROQ_REASONING_MODEL`, and
 * CLAUDE.md's NEVER block recorded that as permanent. The operator's
 * direction of 2026-09-03 reverses it for exactly two stages, and a CLI
 * prompt outranks a written ADR by that document's own rule.
 *
 * *Why these two and not the others.* Groq meters tokens **per model per
 * day**, so a stage moved here stops competing with SCRIPT and RESEARCH for
 * the same 200K. That argument applies to every stage, so it cannot be the
 * whole test — the second test is what a weaker answer costs:
 *
 * - **EXPORT's listing** turns a script that is already written into a
 *   title, a description and hashtags. There is no judgement in it that a
 *   larger model resolves better, it is ~1.5K tokens a render, and it
 *   already falls back to `heuristicUploadMetadata` on any failure. Nothing
 *   downstream reads it; the operator pastes it into YouTube Studio and
 *   edits it if it is wrong.
 * - **CRITIC** is advisory by construction (ARCHITECTURE.md §5.4): its
 *   verdict never stops a signal, it only reaches the audit package. Moving
 *   it also *fixes* something. `src/config/models.ts` used to note that a
 *   critic sharing SCRIPT's model is grading its own work and that the
 *   second opinion had become a second prompt rather than a second model.
 *   It is a second model again.
 *
 * *What deliberately did not move.* EDIT and PLAN were both considered on
 * 2026-09-03 and both declined by the operator. EDIT is the largest consumer
 * in the system (~90-110K tokens a render, ~34 tool turns), so moving it
 * would have been the biggest budget win available — and it is precisely
 * the stage where a weaker model's tool-calling degrades quietly into "every
 * clip as sourced". PLAN's queries are the difference between footage that
 * illustrates the argument and a crystal mobile. Both stay on
 * `GROQ_REASONING_MODEL`, which keeps that model at ~130K tokens a render
 * and two renders a day as the practical ceiling.
 *
 * SCRIPT and RESEARCH are not candidates and never were: one is the product,
 * and the other is already reading sources truncated by
 * `fitToRequestBudget`.
 */
export const GROQ_LIGHT_MODEL = "openai/gpt-oss-20b";
