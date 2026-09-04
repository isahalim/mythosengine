/**
 * Which model answers a reasoning stage. One file, one answer.
 *
 * **Every reasoning stage is a ladder now** (operator direction,
 * 2026-09-04). A stage no longer names one model; it names an ordered list
 * and takes the first rung that answers. `LadderLlmDriver`
 * (src/lib/drivers/llm-ladder.ts) is the mechanism, and it is deliberately
 * dumb: try, and on *any* driver error step down and try the next. Three
 * ladders exist and there are no others:
 *
 * | Stage | Ladder |
 * |---|---|
 * | SCRIPT, PLAN, reranking, RESEARCH's fallback | `GEMINI_REASONING_MODEL` → `GROQ_REASONING_MODEL` → `GROQ_LIGHT_MODEL` |
 * | EDIT (Kinocut) | `EDIT_MODEL` → `EDIT_FALLBACK_MODEL` |
 * | RESEARCH's first attempt | `GEMINI_RESEARCH_MODEL`, four turns, then the row above |
 * | CRITIC, EXPORT's listing | `GROQ_LIGHT_MODEL` alone — unchanged |
 *
 * **RESEARCH's fallback is the general ladder as of 2026-09-04**, Gemini
 * rung included — the operator's "use gemini-3.8-flash first, then fall back
 * to the gemini 3.5 flash-lite and the groq api's gpt models". It is not the
 * thing the 2026-09-02 decision ruled out. That rule was about splicing a
 * second Gemini model into the *middle of one tool conversation*, where it
 * would inherit the first model's signed `thought` steps. This is a whole
 * second attempt from an empty transcript, on a different model id and so a
 * different per-minute bucket, and it starts only after the first attempt
 * has been abandoned entirely.
 *
 * **Why a ladder rather than one model, after 2026-09-01 said the
 * opposite.** That day's failure was not "Gemini is unreliable", it was
 * "Gemini was a *dependency*": five stages went there with a fallback that
 * only fired on quota exhaustion, so the two `500 InternalServerError`s the
 * live run drew fell straight through it and killed the render at SCRIPT.
 * `LadderLlmDriver` fixes exactly that — it falls through on a 500, a 429, a
 * timeout, a malformed body, anything — and it keeps two known-good Groq
 * rungs underneath. A stage can only fail now if all three rungs fail.
 *
 * **Why the descent is sticky.** Once a rung fails inside a stage, that
 * stage does not climb back up for its later calls. A 429 is a statement
 * about the next minute, not about the last request, and re-offering a rung
 * that just refused spends a request to learn the same thing twice — the
 * lesson the Gemini TTS path learned on 2026-09-01 and RESEARCH's driver
 * encodes as `maxAttempts: 1`.
 *
 * **What this does to the token budget, which is the real reason it is
 * safe.** Groq meters tokens per model per day, and until now essentially
 * the whole reasoning path shared gpt-oss-120b's single 200K allowance at
 * ~130K a render — two renders a day, with EDIT's ~90-110K being almost all
 * of it. EDIT is on the qwen3 models now, which have their own **2M a day**
 * allowance (`QUOTAS.groq.tokensPerDayQwen3`), so the largest consumer has
 * left the smallest bucket. What remains on 120b is a few thousand tokens
 * each for SCRIPT, PLAN and reranking plus RESEARCH's ~15-25K *when Gemini
 * does not answer first* — and the daily ceiling stops being the thing that
 * decides how many videos a day this system can make.
 */

/**
 * The **top rung** of the general reasoning ladder: SCRIPT, PLAN, retrieval
 * reranking, and RESEARCH's post-Gemini fallback (operator direction,
 * 2026-09-04).
 *
 * *Why Flash Lite and not the model RESEARCH uses.* Gemini's free tier
 * meters 5 requests/minute **per model**, so putting the general ladder on a
 * different model id from `GEMINI_RESEARCH_MODEL` gives it a bucket of its
 * own. RESEARCH's *first* attempt spends at most four requests against
 * `GEMINI_RESEARCH_MODEL` and never touches this bucket, and a render spends
 * at most three or four here (rerank once, SCRIPT once plus up to one
 * repair, PLAN once). Sharing one model id would have put a render's total
 * at eight against a ceiling of five, which is precisely the arithmetic that
 * lost the 2026-09-01 render.
 *
 * *What RESEARCH's fallback adds to this bucket, on the days it runs.*
 * Since 2026-09-04 this is also the top rung RESEARCH falls back to, and its
 * loop is six turns rather than the four the first attempt is capped at — so
 * a render whose Gemini research attempt failed can ask for more here than
 * the five-per-minute meter allows. That is deliberately left to the ladder
 * rather than capped: the turn that meets the 429 steps down to
 * `GROQ_REASONING_MODEL` and the loop continues there, and any SCRIPT or
 * PLAN call queued behind it does the same. Both cost a request and neither
 * costs a render, which is the whole point of a ladder. The alternative —
 * bounding the fallback to four turns as well — would shorten the Groq loop
 * too, since the turn budget belongs to the stage and not to the rung, and
 * that penalises the path that runs every day to protect one that runs
 * rarely.
 *
 * *Why it is safe for it to be the weakest model of the three.* It is the
 * rung that is tried, not the rung that is trusted. Every stage on this
 * ladder already validates what comes back — SCRIPT and PLAN through
 * `requestValidatedJson`'s schema check, reranking through three checks that
 * a position was actually offered — and a rung whose answer does not
 * validate has cost a request, not a render. Underneath it sit the two
 * models that have been running this pipeline all week.
 */
export const GEMINI_REASONING_MODEL = "gemini-3.5-flash-lite";

/**
 * The **middle rung**: the model that answered SCRIPT, PLAN, reranking and
 * RESEARCH's fallback outright from 2026-09-01 until 2026-09-04, and still
 * answers all four whenever `GEMINI_REASONING_MODEL` does not.
 *
 * *Why it stays in the middle rather than at the top.* Nothing about it has
 * got worse. It is here because it is the known-good floor of a ladder whose
 * top rung is a free-tier model on a 5-requests-per-minute meter — the rung
 * that makes an outage cost a request instead of a render.
 *
 * *What it no longer carries.* EDIT, which was ~90-110K tokens a render
 * across ~34 tool turns and the reason 200K/day meant two renders a day, is
 * on `EDIT_MODEL` since 2026-09-04. CRITIC and EXPORT's listing left for
 * `GROQ_LIGHT_MODEL` on 2026-09-03. What is left here is small and mostly
 * pre-empted by the rung above, so `QUOTAS.groq.tokensPerDayGptOss` has
 * stopped being the constraint that decides the day's output.
 */
export const GROQ_REASONING_MODEL = "openai/gpt-oss-120b";

/**
 * RESEARCH's **first** attempt, on its own Gemini model id and its own
 * per-minute bucket (operator direction, 2026-09-02).
 *
 * *Why RESEARCH gets a rung nothing else gets.* RESEARCH is the one
 * reasoning stage whose output quality is bounded by how much source
 * material it can hold at once. On Groq the whole tool conversation has to
 * fit inside a 7,200-token per-request ceiling, and `fitToRequestBudget`
 * gets there by throwing away tool results the model already went and
 * fetched — a measurably weaker brief, recorded as `toolResultsDropped`.
 * Gemini's intake is large enough that nothing has to be dropped.
 *
 * *Why exactly four turns.* The free tier meters 5 requests/minute per
 * model. RESEARCH's full loop is six, which is what took the render down on
 * 2026-09-01. Four is under the ceiling with headroom, so the attempt never
 * waits on a limiter and never meets a 429 — and four turns holding whole
 * articles do more work than six holding truncations.
 *
 * *Why no ladder within Gemini — still true, and it is a narrower rule than
 * it looks.* Descending to another Gemini model *for the remaining turns of
 * this loop* was considered and declined on 2026-09-02, and stays declined:
 * Gemini's tool transcripts carry signed `thought` steps, whether a second
 * Gemini model accepts the first's signatures is untested, and the failure
 * is a bare `invalid_request` that would only appear live. So this attempt
 * is one model from its first turn to its last, and `GEMINI_REASONING_MODEL`
 * is never spliced into it.
 *
 * What the operator asked for on 2026-09-04 is a different thing, and it is
 * why `GEMINI_REASONING_MODEL` now sits at the top of the *fallback*: when
 * this attempt is abandoned, RESEARCH starts over from an empty transcript,
 * on a different model id and so a different per-minute bucket, carrying no
 * `thought` step from here. Nothing is handed across. Below that rung it
 * descends to Groq, statelessly, which is the replay that is known to work.
 */
export const GEMINI_RESEARCH_MODEL = "gemini-3.8-flash";

/**
 * Turns the Gemini attempt may spend, against a 5 requests/minute ceiling.
 * See `GEMINI_RESEARCH_MODEL`. The fallback ladder keeps RESEARCH's full
 * six — its Groq rungs are paced by a token bucket rather than a per-minute
 * request count, and its Gemini rung steps down to them on a 429.
 *
 * Four also happens to be what makes the *daily* ceiling fit:
 * `QUOTAS.gemini.researchRequestsPerDay` is 20 on this model, so four turns
 * times three renders is 12 with headroom for a re-run.
 */
export const GEMINI_RESEARCH_MAX_ITERATIONS = 4;

/**
 * The **bottom rung** of the general ladder, and the only model CRITIC and
 * EXPORT's listing ever use (operator direction, 2026-09-03 for those two,
 * 2026-09-04 for the rung).
 *
 * *Why these two stages sit here alone.* Groq meters tokens per model per
 * day, so a stage moved here stops competing for gpt-oss-120b's 200K. That
 * argument applies to every stage, so it cannot be the whole test — the
 * second test is what a weaker answer costs:
 *
 * - **EXPORT's listing** turns a script that is already written into a
 *   title, a description and hashtags. There is no judgement in it that a
 *   larger model resolves better, it is ~1.5K tokens a render, and it
 *   already falls back to `heuristicUploadMetadata` on any failure. Nothing
 *   downstream reads it; the operator pastes it into YouTube Studio.
 * - **CRITIC** is advisory by construction (ARCHITECTURE.md §5.4): its
 *   verdict never stops a signal, it only reaches the audit package. Moving
 *   it also ended the compromise where the critic graded its own writer's
 *   work on the writer's own model.
 *
 * *Why it is also the floor under SCRIPT, PLAN and reranking.* Those three
 * would previously fail outright when 120b was rate-limited or out of daily
 * tokens, and SCRIPT failing outright means no video. A third rung on a
 * separate daily bucket turns "no video" into "today's script was written by
 * the small model, and the audit package says so" — which is a trade the
 * operator can see and re-run, unlike a dead render.
 */
export const GROQ_LIGHT_MODEL = "openai/gpt-oss-20b";

/**
 * EDIT's model — the Kinocut tool loop, and nothing else (operator
 * direction, 2026-09-04).
 *
 * *Why EDIT left gpt-oss-120b.* Not because 120b was doing it badly. EDIT is
 * by far the largest consumer in the system — ~90-110K tokens a render
 * across ~34 tool turns — and on the shared gpt-oss daily allowance of 200K
 * that single stage was what made two renders a day the ceiling. The qwen3
 * models carry a **2M** token-per-day allowance
 * (`QUOTAS.groq.tokensPerDayQwen3`, the same reason the deleted footage
 * browser agent ran here), so moving EDIT does not shrink a budget, it
 * changes which budget the stage spends and empties the one that binds.
 *
 * *What makes the move safe now, when moving EDIT to a smaller model was
 * offered and declined on 2026-09-03.* Two things changed on 2026-09-04.
 * `EDIT_TOOLS` is three tools rather than nine — measure, detect scenes,
 * trim — so the tool-calling judgement being asked of the model is much
 * narrower than "pick one of five grades as well". And the failure mode that
 * made a weaker model frightening here is the one this stage was built
 * around from the start: EDIT is not allowed to fail a render at any
 * granularity, so a model that loses the thread costs a clip its trim and is
 * recorded as "left as sourced" in the audit package.
 */
export const EDIT_MODEL = "qwen/qwen3.8-27b";

/**
 * EDIT's second rung, and where the stage **finishes the run** once the
 * first rung has failed once (operator direction, 2026-09-04: "fallback and
 * continue with the rest of the work").
 *
 * The descent is sticky for the whole stage rather than per clip, and that
 * is the operator's wording made literal. A tool loop that has just been
 * refused mid-clip will be refused again on the next clip a few seconds
 * later — the thing that refused it is a per-minute or per-day meter, and
 * neither has moved. Re-offering the top rung once per clip would spend
 * eight failures to learn one fact and stretch the stage out by the
 * limiter's wait each time.
 */
export const EDIT_FALLBACK_MODEL = "qwen/qwen3.6-27b";
