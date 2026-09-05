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
   │  · returns { specificity, topic, title, angle, mustInclude, voice, language }
   │
   ├── specific ──────▶ mint a synthetic `signals` row from the title
   └── topic_only ────▶ rankIdeas(topic, 1)[0] — stage 4's own function
   │
   ▼  queueRunPlan([{ topic, signalId }])
RESEARCH (chat)                            ← the chat route's own
   │  LangChain over Gemini + Google Search grounding
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

## 3. The vague-prompt fallback

> *"if the user prompt is vague like it only includes like the topic (eg make a video on AI), it should just deterministically fallback on the current brainstorming pipeline but always choose the ranked 1 idea for that topic and continue (although the user interface will still be in the chat interface pipeline)."*

Two things decide it, and only one of them is a model:

1. **DIGEST's `specificity`** — the model's opinion.
2. **`isBareTopic`** (`src/lib/pipeline/digest.ts`) — plain code. A prompt of **two content words or fewer**, after stopwords, is a bare topic *whatever the model said*. "make a video on AI" is one content word. An empty `angle` collapses the same way.

The override runs in one direction only. A short prompt the model calls specific is overruled; a long prompt the model calls vague is believed, because length is not the same as an argument.

The fallback itself has no model in it at all: `rankIdeas(db, topic, 1, [])[0]`, the exact function the Ideas screen calls, blending BM25 relevance, engagement and the 12-hour-half-life recency weight. The same corpus and the same topic give the same answer, and the operator can open stage 4 and see why that story won.

**The operator never leaves the chat surface.** Only the source of the idea changes.

---

## 4. RESEARCH on this route

`src/lib/rag/langchain-research.ts` — LangChain over `GEMINI_RESEARCH_MODEL` with **Google Search grounding** (operator direction: LangChain for research; grounding chosen over a scraped SERP and over adding Tavily/Brave).

*Why not BM25 over `signals`.* A brainstorm-route idea **is** a row in that corpus, so retrieval is a lookup and `read_source` can be confined to what was retrieved. A chat brief has no such anchor — it may be about something an hour old that no feed this system polls will ever carry. Retrieval would return something *adjacent*, and a script grounded in something adjacent is worse than an honest ungrounded one.

Everything about the failure contract is the brainstorm route's, deliberately:

| | |
|---|---|
| **Cannot fail a render** | Any failure → the corpus path → exported flagged `ungrounded`. An upgrade must not become a dependency (2026-09-01), and that applies to a framework exactly as it applied to a provider. |
| **Four turns** | `GEMINI_RESEARCH_MAX_ITERATIONS`. Same cap, same arithmetic: 5 requests/minute per model, and a six-turn loop crossed it live. |
| **One attempt** | `maxRetries: 0`. A retry spends a request against a window it cannot outrun. |
| **A real timeout** | `GEMINI_RESEARCH_TIMEOUT_MS` (180s), as an `AbortSignal`, never a framework default. A timeout under the real cost deletes a path rather than degrading it. |

**The trust boundary.** A claim is kept only when its URL is one the provider's own grounding metadata says it actually consulted. That is this route's equivalent of `finalizeBrief`'s `seen` check: there the model may only cite what retrieval returned, here only what search returned. A brief with no traceable citation is an error, not a brief.

Those citations carry `signalId: null` and `sourceKind: "web"` — which is why `ResearchCitation.signalId` was widened rather than filled with a fabricated id, and why the audit package's RESEARCH line reports `gemini-grounded` rather than `gemini`. A reviewer can look a corpus citation up here; a web citation they have to open.

---

## 5. The surface

### Compose (`src/app/chat/StageCompose.tsx`)

Board panel 1. One pill input, `+` on the left, submit on the right. The placeholder cycles behind a blinking cursor bar and the whole cue disappears on the first keystroke. History below.

**The placeholder text is static copy, not model-generated.** The board's note beside it reads "use gemini 3.7 flash for now"; no such model id exists in `src/config/models.ts`, and more to the point this is the one surface that must render before any network call resolves — a cycling hint that waited on a model would be a blank input on every cold load. Flagged rather than quietly invented.

### Building (`src/app/chat/StageBuilding.tsx`)

Board panels 2 and 3, one screen, no stage change.

1. **The orb emerges from the text input** and drifts gently up (`.orb-rise` in `shards.css`). It replaces both the board's black hole and its aurora. The scale runs slower than the translate, so it keeps swelling after it has arrived — which is what reads as fluid rather than as a moving object.
2. **The input locks**, still holding the prompt, greyed.
3. **The shards gather and orbit** (`OrbitField.tsx`). They are literally the `edgeLayout` fragments — the same glass pinned to the borders of every other screen — leaving their edges and coming inward, which is the board's "gathering pieces from edges of website". `EdgeFrame` is unmounted for the life of this screen: two sets of border glass, one of them departing, would read as a copy.
4. **The card heals** as each pipeline milestone lands. `ForgePane`'s `fracture` goes `1 → 0`.
5. **The shatter progression**: `ShardPlayer`, unmodified — sealed → cracked → open → autoplay. The orb is visible behind the sealed slab and fades on the first crack, exactly as the board says.
6. **Download · Review · Metadata · Discard** underneath (`ExportActions.tsx`, shared with stage 6).

### The orbit, mechanically

Three transform layers, three owners, and **no two on one element**:

| Layer | Owner | Carries |
|---|---|---|
| `.orbit-shard` (wrapper) | `OrbitField`'s rAF loop | the orbit, the gather, the dock |
| `.shard` | `useShardField`'s spring loop | tilt, parallax, hover lift |
| — | — | nothing else; in particular **not** `.float-group`, whose drift keyframe animates the same property |

`useShardField`'s targets are closure-private and are reset by its own pointer handlers, so orbit positions could not be pushed through it even if that were desirable. This is the same idiom `ShardPlayer` uses for its spread, and it is what keeps the shards interactive while they orbit.

`orbit.ts` is pure arithmetic and fully unit-tested; the loop does nothing but call it and write the result. Note that `orbitPose` returns offsets in **% of the field** and the loop converts them to pixels — a `translate` percentage resolves against the *wrapper's own box*, and these boxes range from 6% to 27% wide.

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
| DIGEST | The classification. The run takes the bare-topic branch, flagged. |
| An attachment | That file's content. One line in the digest prompt saying so. |
| Grounded RESEARCH | The grounding. Falls to the corpus path, then to `ungrounded`. |
| The dispatch | Nothing is built. The brief is `failed` with the reason on it — the operator is reading the transcript, not the run view. |
| A bare topic with an empty corpus | Nothing is built, and it is `skipped`, not a failure. At most two model calls were spent. |

The only thing that ends a chat run early is having no idea at all to build.

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
| `src/app/chat/**` | Compose, Building, OrbitField, orbit arithmetic, the shared export actions. |
| `src/app/orb/**` | The vendored 21st.dev Gradient Orb, and the lazy wrapper that keeps it out of the app's budget. |
