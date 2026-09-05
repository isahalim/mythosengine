# The chat route

*Operator direction, 2026-09-04. Design board: `~/Downloads/design_board_chat_pipeline.png`.*

`docs/SIX_STAGES.md` governs the brainstorm route. This file governs the other one.

---

## 0. What it is, and what it is not

An operator who arrives with an idea already in their head types it, attaches anything that helps, and the engine builds **that** video. It is not a conversation: **one prompt makes one run**, the input locks until that run ends, and the board says so outright — *"won't accept anything until run ends (success or fails)"*.

**It is not a second pipeline.** `scripts/pipeline/chat-render.ts` is a *prelude*. It digests the brief, grounds it, manufactures exactly the state `renderOneVideo` has always expected — a `signals` row in state `scored`, and a run plan naming it — and then calls that function. SCRIPT, CRITIC, PLAN, SOURCE, TTS, ALIGN, EDIT, RENDER, HOST, AUDIT and EXPORT are the code that has been rendering videos all week, unchanged and unaware of which route they are on.

That was the whole design constraint. The obvious shape for "a second way to make a video" is a second orchestrator, and it would have meant two places that know about the Groq token bucket, the Gemini TTS Pacific-day ledger, the sticky ladder descent, the audit contract and the export lifecycle — with the second one drifting from the first the moment either changed. Instead the divergence is confined to **one nullable value** (`OperatorBrief`) and **one stage** (RESEARCH), because RESEARCH was already the only stage whose output crosses into the rest of the run.

---

## 1. The shape of a run

```
COMPOSE (browser)
   │  POST /console/briefs — multipart: the prompt, and up to 5 files
   │  · stores the prompt in D1, the bytes in R2 under briefs/<id>/<n>
   │  · mints the trace, dispatches render.yml with brief_id
   │  · MAKES NO MODEL CALL — see §2
   ▼
DIGEST  (GitHub Actions, stage 0)          ← the chat route's own
   │  general ladder: Flash Lite → gpt-oss-120b → gpt-oss-20b
   │  · reads the attachments (multimodal, for images and PDFs)
   │  · returns { topic, title, angle, mustInclude, voice, language }
   │  · NO branch: whatever it returns describes the brief that gets built
   ▼  mint a synthetic `signals` row from the title
   │  queueRunPlan([{ topic, signalId }])
RESEARCH (chat)                            ← the chat route's own
   │  LangChain + Google Search grounding
   │  · gemini-3.8-flash × 4 turns, then gemini-3.5-flash-lite × 2,
   │    continuing from the pages the first one found
   │  · fails soft → the corpus path → `ungrounded`
   ▼
── renderOneVideo(env, traceId, { planId, brief }) ──────────────────
SCRIPT → CRITIC → PLAN → SOURCE → TTS → ALIGN → EDIT → RENDER
       → HOST → AUDIT → EXPORT                    (all unchanged)
```

The chat surface polls `GET /console/briefs/:id` **and** `GET /console/runs/:traceId`, because DIGEST's conclusion lands on the brief row minutes before the run has a video to report.

---

## 2. Why the digest runs in Actions

CLAUDE.md: **the Worker makes no model call anywhere**, and since 2026-09-03 it holds no model credential at all. That rule is not bent for a nicer chat latency.

So `POST /console/briefs` does exactly three things — store the prompt, store the attachments, start a run — and every judgement the surface appears to make (*what topic is this? is it specific enough to build? what should it be called?*) is made by DIGEST on the runner and written back onto the `briefs` row.

The cost is honest and visible: on a cold self-hosted runner the first line of the transcript can take a minute. The board's own sequence absorbs it — the orb rises the instant the operator presses enter, so the acknowledgement is the animation, not a reply.

---

## 3. There is no vague-prompt fallback

*Operator direction, 2026-09-05: "get rid of the default fallback for prompt requests that are very vague to just follow the other route of picking the topic most similar and choosing the ranked 1st idea because this introduced a weird bug which should never happen ... Even vague prompts like make a video on AI should just let the lang chain run to do research."*

Until then, DIGEST also judged whether the operator had named a real video, and a brief it called `topic_only` was replaced by `rankIdeas(topic, 1)[0]` — the corpus's top-ranked story for that topic.

**How it failed.** The operator typed *"make a video on the lindsay clancy trial"* — three content words, so the `isBareTopic` word-count floor did not fire. The model returned a title and an **empty `angle`**, because the prompt names a subject and does not argue anything about it. An empty angle was itself treated as vagueness, so the run went to the ranked list and produced an unrelated politics story. The operator's actual request was discarded by a classification they never saw, and the history line said `succeeded · politics, from the ranked list`.

**What replaces it: nothing.** Every brief mints a signal from its own title and goes to grounded RESEARCH. A prompt with no angle in it is a search with a subject and no angle, and `langchain-research.ts`'s user prompt already says what to do with one — *"the operator gave no specific angle; find the most contested thing about this subject"*. That is a search of the live web for what the operator asked about, rather than a lookup of what this system happened to have ingested.

Gone with it: `isBareTopic`, `TOPIC_ONLY_MAX_CONTENT_WORDS`, `BriefDigest.specificity`, and `brief-prelude.ts`'s import of `rankIdeas`. `contentWords` stays, because `guessTopic` needs it when no model answered at all.

**A dead DIGEST no longer changes the subject either.** `heuristicDigest` returns the operator's own sentence as the title with the topic guessed from its words. A degrade may cost a brief its quality; it may not swap its subject for someone else's.

---

## 4. RESEARCH on this route

`src/lib/rag/langchain-research.ts` — LangChain over `GEMINI_RESEARCH_MODEL` with **Google Search grounding** (operator direction: LangChain for research; grounding chosen over a scraped SERP and over adding Tavily/Brave).

*Why not BM25 over `signals`.* A brainstorm-route idea **is** a row in that corpus, so retrieval is a lookup and `read_source` can be confined to what was retrieved. A chat brief has no such anchor — it may be about something an hour old that no feed this system polls will ever carry. Retrieval would return something *adjacent*, and a script grounded in something adjacent is worse than an honest ungrounded one.

Everything about the failure contract is the brainstorm route's, deliberately:

| | |
|---|---|
| **Cannot fail a render** | Any failure → the corpus path → exported flagged `ungrounded`. An upgrade must not become a dependency (2026-09-01), and that applies to a framework exactly as it applied to a provider. |
| **Four turns, then two** | `GEMINI_RESEARCH_MAX_ITERATIONS` on `gemini-3.8-flash`, then `GEMINI_RESEARCH_FALLBACK_ITERATIONS` on `gemini-3.5-flash-lite`. Same arithmetic as ever: 5 requests/minute **per model**, so four on one id and two on another is comfortably under both. See below. |
| **No HTTP retry** | `maxRetries: 0` on both. A retry spends a request against a window it cannot outrun; a *turn* is different, because it carries the work already done forward. |
| **A real timeout** | `GEMINI_RESEARCH_TIMEOUT_MS` (180s), as an `AbortSignal`, never a framework default. A timeout under the real cost deletes a path rather than degrading it. |

### The turns, and the handover

*Operator direction, 2026-09-05: "use gemini-3.8-flash max call 4 times and if necessary fallback on gemini-3.5-flash-lite by continuing from the leftover work."*

Before that this stage was a **single** `invoke`. The four turns it advertised existed only in the prompt's own text: a reply with no JSON in it, or one whose claims were all untraceable, ended the stage and the video went out `ungrounded`.

Now the stage keeps a **workpad** — every page any turn grounded on, plus the last unusable draft — and:

1. Up to four invocations of `gemini-3.8-flash`. A turn that returns a usable brief ends the stage. A turn that does not is told *what* was wrong and gets another, with the conversation intact.
2. A **throw** (429, timeout, 500) ends that model's turns immediately rather than burning the rest of them. Whatever it had found is kept.
3. Up to two invocations of `gemini-3.5-flash-lite`, opened with the leftover work: the URLs and titles the first model's searches actually returned, and its own last draft. It may cite any of them, and it may search for more.

**Why continuing across two Gemini models is allowed here and forbidden in `research-provider.ts`.** That rule is about splicing a second Gemini model into a live *tool conversation*, where it inherits the first model's signed `thought` steps — untested, and a failure that only shows up in production. This path has no client-side tool loop at all: search is the provider's own and runs server-side, and what crosses is plain text. Nothing signed, nothing replayed, and a different model id means a different per-minute bucket.

`fallbackReason` and the model that actually closed the brief both reach the audit package, because an export may never be vague about which provider answered a reasoning stage.

**The trust boundary.** A claim is kept only when its URL is one the provider's own grounding metadata says it actually consulted — from **any** turn of this stage, since every one of those pages was genuinely fetched for this brief. That is this route's equivalent of `finalizeBrief`'s `seen` check: there the model may only cite what retrieval returned, here only what search returned. A brief with no traceable citation is an error, not a brief.

Those citations carry `signalId: null` and `sourceKind: "web"` — which is why `ResearchCitation.signalId` was widened rather than filled with a fabricated id, and why the audit package's RESEARCH line reports `gemini-grounded` rather than `gemini`. A reviewer can look a corpus citation up here; a web citation they have to open.

---

## 5. The surface

### Compose (`src/app/chat/StageCompose.tsx`)

Board panel 1. One pill input, `+` on the left, submit on the right. The placeholder cycles behind a blinking cursor bar and the whole cue disappears on the first keystroke. History below.

**The placeholder text is static copy, not model-generated.** The board's note beside it reads "use gemini 3.7 flash for now"; no such model id exists in `src/config/models.ts`, and more to the point this is the one surface that must render before any network call resolves — a cycling hint that waited on a model would be a blank input on every cold load. Flagged rather than quietly invented.

### Building (`src/app/chat/StageBuilding.tsx`)

Board panels 2 and 3, one screen, no stage change.

1. **The orb rises into the centre of the video card** (`.orb-rise` in `shards.css`, operator direction 2026-09-05: "make sure the orb is in the center as the video card gets slowly formed"). It replaces both the board's black hole and its aurora. The scale runs slower than the translate, so it keeps swelling after it has arrived — which is what reads as fluid rather than as a moving object. It is rendered by `OrbField`, not by `StageBuilding`, because it is several times the card's width and the column the card lives in scrolls and clips.
2. **The input locks**, still holding the prompt, greyed.
3. **The card is built out of shards**, one fragment per milestone (operator direction, 2026-09-05: "during when the pipeline is running, don't pre-make the shards ... they should slowly get placed one by one as the pipeline progresses just like how it is in the demo's video card progression"). `ForgePane` starts with **no** fragments and takes one as each fact lands (`assembled` → `landedFragments`), each one free floating in place. Stage 5 passes no `assembled` and keeps the whole mosaic: a grid of six part-built cards reads as a rendering fault, not as progress.
4. **The shatter progression**: `ShardPlayer`, unmodified — sealed → cracked → open → autoplay.
5. **Download · Review · Metadata · Discard** underneath (`ExportActions.tsx`, shared with stage 6).

### What this screen deliberately does not draw

*Operator direction, 2026-09-05: "I want to make the design more simple, so completely remove the orbiting glass shards and debris! Also there shouldn't be a empty purple frame! The glass shards should settle in free float to make the video card, but without any guidance of those purple lines!"*

Three things were removed together, and they were one thing:

- **The orbit.** `OrbitField` gathered the ten `edgeLayout` fragments off the page borders, shrank them to a twentieth of their size, tumbled them on three axes around a tilted ring — half behind the orb, half in front, by `depth = sin(angle)` and a z-index flip — extruded each into an eight-layer slab so it was never edge-on and zero pixels wide, and docked one into the card per milestone on an eased approach to a counted target. All of it is gone, along with `orbit.ts`'s geometry and `OrbitField.tsx` itself. What is left is `OrbField.tsx` (the orb, centred on the measured card) and `progress.ts` (`milestoneFraction`, the counted rule the whole thing was driven by).
- **The debris.** Seventy-six non-interactable specks trailing the ring, sheared into arcs by differential rotation.
- **The crack lines on this card.** `ForgePane` draws its fracture SVG only when `assembled` is undefined — which is precisely "this pane is not being built out of milestones", i.e. stage 5. On a card with no fragments in it yet, a full-strength fracture drew a violet wireframe of a video nothing had made: an outline of the shape the fragments were going to take, which is a guide, not a fact. `fracture` still rides the counted fraction and now reaches only the glow.

`EdgeFrame` is mounted here again, like every other stage — it was unmounted for four days only because the orbit was taking those same fragments.

### The orb leaves when the card is whole

*Operator direction, 2026-09-05: "when the glass video card gets healed, fade out the gradient orb at that time. Dont wait for the first click/shatter to remove it!"*

`OrbField`'s `healed` is `exportId !== null` — the sixth counted fact, the same one that turns the pane into a player. It used to be the player's own first crack, which is an act the operator performs: a run that finished while nobody was watching kept a `min(38vw, 34rem)` orb burning through the finished video until someone clicked it. `.orb-rise--gone` is a 1.4s fade, not a cut.

The orb's centre is **measured**, not assumed: the loop reads the card's box (`data-orb-anchor`) every frame, because the card is a `ForgePane` at one moment and a `ShardPlayer` at the next, in a column that scrolls, and a hard-coded percentage is its centre on exactly one viewport height.

### The card is bounded by the viewport's height

*Operator direction, 2026-09-05: "move the video card down so it doesn't clip at the top."* The card is `w-1/2 max-w-[min(16rem,24vh)]` and the column carries `pt-6`. A flat `16rem` is 455px of 9:16 card, and the finished state is that card plus a caption, four buttons and a metadata sheet — more than what is left of a laptop's viewport under the header and the locked prompt, so the column scrolled and scrolling put the top of the video under its own edge. The height cap is what removes the scroll on an ordinary window; the padding keeps the card's top edge clear when the metadata sheet does make it scroll.

### It scrolls

*Operator direction, 2026-09-05: "allow scrolling in the 2nd step of the chat route so that once the video is done, the user can actually scroll to view the metadata."* The body is `overflow: hidden` and every stage is `h-dvh` — the stage machine owns the viewport and stages scroll internally, which is what stage 6 already does. The finished state is a 9:16 player, four buttons and a metadata sheet, which on anything short of a tall desktop is more than what is left of the viewport: the sheet was rendered and unreachable. The cost is that `overflow-x` follows `overflow-y` to `auto` whether it is asked to or not, so a fragment lifting toward the cursor clips at the box's edge.

### Progress is counted, never estimated

Six observed facts, each one a row something wrote after doing the thing:

```
digested · story · script · render · encoded · export
```

The first two are this route's own; the last four are `Stage5Forge`'s `milestones` unchanged. The rule is stated in three other places in this codebase and holds here for the same reason: an ETA that slid backwards would be the one thing on this screen that was not true.

### Review

`TopBar` carries a **Review** entry on both routes, reachable even from the fork, and it renders the existing `Stage6Review` — *"a dedicated review section for past videos that haven't expired, same as the current step 5 (shares same path)"*. A finished video is a finished video; where its idea came from changes the audit package, not the review surface.

---

## 6. Defaults

**Kore, English, expressive.** All three were already the defaults and all three stay them; a brief may override the first two, per render, never touching the directive.

- **Voice** — `HOST_GEMINI_VOICE` (`Kore`) on the Gemini path, the diversity rotation on Edge.
- **Language** — English. Gemini TTS has **no language field**; its only lever is prose in the input, so a language request reaches it as a direction line. Edge encodes the locale *in* the voice name, so a language there means picking a different voice — and the pool is eight English voices, so anything else is an **unmet request that is reported**, never silently narrated in English. `src/lib/pipeline/narration-voice.ts` holds both facts in one place.
- **Expressive delivery** — untouched. `rollPerformance` always seeds laughter into `nonVerbal`, and `delivery-tags.ts` still guarantees a tag reaches only the Gemini TTS request and never `scripts.body`, ALIGN, or the burned-in captions.

---

## 7. The synthetic signal

The hinge the whole route turns on (`src/lib/pipeline/brief-signal.ts`).

Everything downstream of SCRIPT assumes a signal that genuinely exists in state `scored`: the foreign key on `scripts.signal_id`, `claimNextRunPick`'s eligibility subquery, `queuePlan`'s validation, the `scored → scripted` transition. So rather than teaching eleven stages about a second kind of subject, the chat route **mints the thing they already understand**.

- `sources.kind` gained `'operator'` (migration 0017) — `signals.source_id` is a NOT NULL foreign key and the old CHECK refused one. One row, `enabled: 0`, never polled.
- The signal is inserted **directly as `scored`**, skipping `observed`. SCORE picks a winner out of near-duplicate feed items; there is no cluster here. Passing through `observed` would put the brief in a duplicate-detection pass it can only lose — a brief about a story already in the corpus would be rejected as a duplicate of the very story the operator is trying to talk about.
- Queueing a **real run plan** is what makes PLAN's prompt, SOURCE's topic-aware YouTube download cap and EXPORT's hashtags need no chat-route special case at all: `claimedPick.topic` is populated the way it always was.

**One accepted side effect, stated rather than discovered:** the brief's signal joins the BM25 corpus immediately, so a *later* RESEARCH run can retrieve and cite it. Mild — the title is a headline about a real subject, and `read_source` cannot fetch its `operator://` URL — and excluding it would mean teaching the retriever about source kinds, which is a larger change for a smaller problem.

---

## 8. What a failure costs

| Fails | Cost |
|---|---|
| DIGEST | Its reading of the prompt. The run continues on the operator's own words with the topic guessed from them, flagged. It never changes what is being built. |
| An attachment | That file's content. One line in the digest prompt saying so. |
| A turn of grounded RESEARCH | Nothing yet — the next turn is told why, and keeps the pages already found. |
| All six turns of grounded RESEARCH | The grounding. Falls to the corpus path, then to `ungrounded`. |
| The dispatch | Nothing is built. The brief is `failed` with the reason on it — the operator is reading the transcript, not the run view. |
| SCRIPT with nothing to write about | `renderOneVideo` returns `skipped`; the brief is closed with the reason. |

There is no longer any way for a brief to resolve to *nothing*: the thing it resolves to is the operator's own sentence, and that always exists.

### One bug worth remembering

The first version of `chat-render.ts` imported `renderOneVideo` from `render.ts`, whose `main()` ran at module scope — so importing it **started a second, unrelated brainstorm render**, claiming a queued pick from an earlier session and spending the day's token budget beside the chat run the operator actually asked for. It never ran with credentials; it was found in a local run by two `main` frames in one stack.

`render.ts` now guards its entry on `import.meta.url === pathToFileURL(process.argv[1] ?? "").href`, `scripts/pipeline/render-entry.test.ts` keeps it there, and the branch logic moved into `brief-prelude.ts` so the glue between DIGEST and the render is covered by tests rather than by reading. Glue is where the mistakes are.

---

## 9. Files

| File | What it is |
|---|---|
| `src/server/console/briefs.ts` | `POST/GET /console/briefs`. **Makes no model call.** |
| `src/server/internal/brief-blob.ts` | `GET/DELETE /internal/briefs/:id/:n` — the pipeline reading attachments back, behind `PIPELINE_BATCH_TOKEN`. |
| `db/briefs.ts`, migration `0017` | The `briefs` and `brief_attachments` rows, and `sources.kind` widened. |
| `scripts/pipeline/chat-render.ts` | The process: environment, drivers, lifecycle row. Ends by calling `renderOneVideo`. |
| `src/lib/pipeline/brief-prelude.ts` | The branch logic — DIGEST, specific-vs-bare, the run plan. Here rather than in the script so it is testable without running a pipeline. |
| `src/lib/pipeline/digest.ts` | DIGEST, stage 0. Never fails. |
| `src/lib/pipeline/brief-attachments.ts` | Attachment → text. Never fails. |
| `src/lib/pipeline/brief-signal.ts` | The synthetic signal. |
| `src/lib/pipeline/narration-voice.ts` | Kore/English, and what an unmet request costs. |
| `src/lib/rag/langchain-research.ts` | Grounded RESEARCH. |
| `src/app/stages/StageFork.tsx` | The fork. |
| `src/app/chat/**` | Compose, Building, OrbField, the counted progress fraction, the shared export actions. |
| `src/app/orb/**` | The vendored 21st.dev Gradient Orb, and the lazy wrapper that keeps it out of the app's budget. |
