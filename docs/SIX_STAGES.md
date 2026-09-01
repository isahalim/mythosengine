# The operator surface — six stages

Supersedes `CONSOLE_SPEC.md` §3–§5 (the dashboard, chat, voice and settings
pages) as of **2026-08-31**. `CONSOLE_SPEC.md` remains authoritative for
passkey auth (§1), step-up reauth and the key vault (§2), and the directive
model the pipeline reads.

Built from three hand-drawn boards supplied by the operator. Where this
document and the boards disagree, the boards win.

---

## Why it looks like this

The old console was six pages of bento cards behind a radial nav. It was a
dashboard: it told you what the pipeline had done. This is a workspace: it
is how you tell the pipeline what to do, and it is one continuous surface
rather than a set of routes.

The material is real shattered glass — the 21st.dev component **"Broken by
Design"** by Guglielmo Giannattasio (@gughigug), used with its exact assets.
Sixteen fragments traced from an actual fracture, each an independent 3D
layer driven by one rAF spring loop, tilting toward the cursor. The atlas
PNGs are vendored to `public/shards/`; nothing loads from a third-party CDN
at runtime.

Two adaptations were needed, both recorded in the file headers:

- **The light is inverted.** The atlas is a glass render photographed
  against black. On our white ground each fragment would read as a dark
  blob, so `.shard-face` inverts the sprite and composites `multiply`: the
  near-black body inverts to near-white (a multiply no-op, so the fragment
  is genuinely transparent and the spheres drift through it) and the bright
  specular edges invert to near-black (crisp dark fracture lines). Same
  pixels, same silhouette, same facets — only the room changed.
- **The audio was dropped.** The source ticks on hover and ships a mute
  toggle. The boards never ask for sound, and sixteen ticks as a cursor
  crosses a pane is noise.

Behind everything: six big rainbow spheres drifting around the centre like
lava lamps, painted `multiply` over white so overlaps genuinely combine
(amber over teal really does resolve green). They collide elastically and
trade colour on contact, relaxing back toward their own hue afterwards so
the palette mixes visibly without converging to grey.

---

## The stages

Stage 1 is the landing. Stages 2–6 are the five nodes on the bubble rail,
and share one persistent frame: the glass moved out to the edges, the rail
across the top, the spheres still drifting.

| # | Rail | What the operator does | Reads | Writes |
|---|---|---|---|---|
| 1 | — | Signs in, or enrols a passkey | — | `/auth/passkey/*` |
| 2 | How many | Lights one shard per video wanted (`# of glows = # of videos`) | — | local only |
| 3 | Topics | Each lit shard fuses with a new one; a caustic dial gives it a topic colour | — | local only |
| 4 | Ideas | A larger shard joins each video, carrying its story | `GET /console/ideas` | local only |
| 5 | Agents deployed | Watches each video's pane heal as the pipeline works | `GET /console/runs/:id`, `…/montage` | `POST /console/run-plan`, `POST /console/dispatch` (on entry) |
| 6 | Review / past work | Downloads, marks reviewed, discards, runs it again | `GET /console/exports` | mark-reviewed, discard |

### Stage 2 — the shard is the input

There is no number field. The operator lights as many pieces of glass as
they want videos and the count follows. Lit fragments carry a **dispersed
rainbow** — what a prism does to white light — because no topic has been
named yet.

### Stage 3 — colour is meaning

The fragment the operator lit is that video's identity and keeps its
rainbow for the entire run. Only the pieces that join it afterwards take a
topic's hue. Hovering the dial fans **caustic rays** across the topic ring,
tinted by whichever choice the cursor is on, so the colour is previewed
before it is committed.

"Let the agent choose" is the eighth choice and keeps the rainbow, because
no topic was named.

### Stage 4 — where the stories come from

`GET /console/ideas` is a BM25 read over the `signals` corpus. No model
writes that list, and the stage says so. A video whose operator chose "let
the agent choose" is ranked across **every** topic and the strongest signal
wins; the topic that won is recorded separately from the operator's choice,
because `agent` is not a topic the queue accepts and queuing it would 422.

Anything already spoken for elsewhere in the run is excluded, so one run
never makes two videos about the same story.

### Stage 5 — the fracture is evidence, not a progress bar

`src/server/console/runs.ts` is explicit that the waiting screen "does not
interpolate a percentage, estimate a finish time, or report a stage the
pipeline has not actually recorded." The forge obeys that literally.

`fracture` counts four **observed row facts** per video — a script row
exists, a render row exists, that render says `rendered`, an export row
exists — and nothing else. A pane at half fracture means exactly two of
those are true. It is not an estimate of how far along the run is.

Glow leaks from the cracks while the pipeline is working, and the fracture
closes as those facts land. Inside the fragments, preview stills for the
script's keywords cycle like dreams. **Those stills are from Pexels and are
not the rendered footage** — the stage keeps saying so on screen, because
the footage in the video comes from the maintained, provenance-tracked
library and never from there.

`not_triggered` is a real state, not an error: a dispatch with no
`workflow_dispatch` credential records a run it cannot start, and the stage
says that rather than spinning forever.

### Stage 6 — whole glass

A finished video's pane has no cracks. That is the visual promise stage 5
was making.

Every card carries the audit context an export must never travel without
(hook, footage, voice, expiry), and each field renders as *missing* when
the API did not return it — never as a plausible default. There is no
publish button, because there is no publish path: this system holds no
upload credential by design, and the copy says so.

---

## What was deleted, and what was kept

Deleted with the console (operator direction): every `/console/*` page, the
chat and voice agents (`src/server/agent/**`, `src/server/console/chat.ts`),
the MCP server and its tokens (`src/server/mcp/**`), and the dashboard
aggregate `GET /console/summary`. The Worker consequently makes no Groq
call at all any more.

Kept, because they are not "sections of the website": the settings /
directive routes (`scripts/pipeline/render.ts` reads them every run), key
rotation, and the killswitch. The step-up reauth gate those last two sit
behind lost its only test when MCP token issuance went, so
`router.test.ts` gained a direct test for it.

The `chat_sessions`, `chat_messages` and `mcp_tokens` tables are still in
`db/schema.ts`. Dropping them needs a destructive migration against a live
D1, which nobody asked for.

---

## Revision — 2026-08-31, first pass (operator direction)

Changes to the above, all from a second pass on the boards:

- **No cards.** Stages 3, 4 and 5 no longer lay videos out in a grid of
  glass-card panels. The shards lit in stage 2 keep free-floating around
  the centre for the rest of the run, gaining the fused topic piece and
  then the larger story piece, and are clicked directly. A video is not a
  card containing glass — it *is* its glass, from the moment it is lit to
  the moment it is downloadable (`src/app/glass/FloatingField.tsx`,
  `videoGlass.ts`).
- **The forge card is made only of shards.** No panel, no rounded
  rectangle: the fragments themselves tile a 9:16 card and the gaps
  between them are the cracks. It floats like every other group until the
  fracture closes.
- **The caustic ray fan is gone.** It read as decoration on top of the
  thing being chosen rather than as light falling on it.
- **Every fragment is interactive**, including the border ones — they tilt
  and highlight like any other, at a smaller lift, and never take colour.
- **The hover highlight releases fast.** `.shard`'s filter transition is
  asymmetric: ~90ms out, ~220ms in. Symmetric at 0.45s, the shard you had
  just left kept its glow most of the way across its neighbour.
- **The selection glow is softened.** The dispersion layer is blurred
  inside its own mask, so the six hues melt into each other instead of
  meeting at hard seams, at about half the old strength.
- **The spheres actually move, and are fainter.** The old speed moved a
  ~700px blurred sphere about 45px/s — imperceptible, hence "they are
  stationary" — and six elastically-colliding spheres settle into a stable
  orbit quickly. Speed is up ~3x and each sphere now carries an
  incommensurable two-term wander so the field never repeats.
- **Review is always reachable** from the rail. It is called "past work";
  gating it on the *current* run having produced something meant the
  operator could not look at their own finished videos.
- **A live session resumes on reload.** The cookie outlives the tab; the
  app now probes one authenticated read on mount instead of asking for the
  authenticator again.

## Revision — 2026-08-31, second pass (operator direction)

- **Stage 6 has no cards.** The white `.glass-card` panel behind each
  finished video is gone; the fragments are the shape, exactly as in the
  forge, and each entry drifts on its own phase
  (`.float-group--inline`). A grid rather than stage 5's ring, because this
  is the whole library of past work and a ring of six positions stops being
  a layout at the seventh video.
- **The fragments show a sneak peek.** Each one masks a Pexels still pulled
  for that video's own script keywords, through a new read-only route
  `GET /console/exports/previews` (`src/server/console/montage.ts`
  `getExportPreviews`). It shares the live montage's per-keyword day-long
  cache, so a video the operator watched being forged shows the identical
  stills when they come back to it and costs no extra request. **These are
  previews, not footage** — the stage says so, and nothing here writes to
  `footage_segments`.
- **The border fragments actually react now.** They always ran the same
  spring loop as every other fragment; they were unreachable.
  `ui/StageFrame.tsx` is a full-viewport box at `z-10` and the edge frame
  sits at `z-0` behind it, so every `pointermove` was consumed before it
  arrived. The chrome is now pointer-transparent and the things that want
  events opt back in (`.shard` and `.float-group` already declare
  `pointer-events: auto`, and a descendant with `auto` inside a `none`
  ancestor is still hit-tested). Verified against the running app: hovering
  a border fragment sets `.shard--hot` and writes a real tilt transform.
- **The spheres are slower and genuinely fluid.** Speed 0.16 → 0.055 and
  the wander frequencies down by about two thirds, which alone would have
  brought back the "they are stationary" problem — so each sphere's radius
  now breathes (`BREATHE`), and the silhouette deforms continuously even
  when the centre has barely travelled. Shape change is what reads as
  fluid at a speed at which pure translation reads as nothing.

## Revision — 2026-08-31, the run actually starts now

Stage 4's "Deploy agents" button used to record a run and start nothing.
Three separate things had to be true for it to work, and none of them were:

1. **No credential.** `POST /console/dispatch` had no way to reach GitHub.
   It now drives `src/lib/drivers/github-actions.ts` — one method, one
   scope, `Result<T, DriverError>` like every other driver — when
   `GITHUB_DISPATCH_TOKEN` and `GITHUB_REPOSITORY` are set. Without them it
   still records the run and reports `not_triggered`, which was always the
   honest answer and stays the fallback.
2. **Two different traces.** The console stamped one `trace_id` and
   `render.ts` minted another, so stage 5 polled a trace the run would
   never write to and sat on "waiting for the first script" even after the
   run had exported. The console now decides the id and hands it down as a
   workflow input; `render.ts` adopts `PIPELINE_TRACE_ID` when it is set.
   GitHub's dispatch endpoint returns no run id, so the identifier has to
   travel downward — there is nothing to read back.
3. **A label no runner had.** Both self-hosted workflows targeted
   `[self-hosted, mythos-footage]`. The registered runner reports
   `self-hosted, macOS, ARM64`, so a dispatch would have queued forever.

`render.yml` also takes a `count`, which is how many picks the operator
queued, and invokes `render.ts` that many times — one signal each, a clean
process each, and a video that fails takes only itself down.

One consequence worth stating plainly: **the runner is the operator's
laptop**, and it is online only while `./run.sh` is running. A dispatch made
while it is offline queues, correctly, and starts when they bring it up.

## Revision — 2026-09-01, the first video the console actually made

The run works end to end. `POST /console/dispatch` starts `render.yml` on the
operator's laptop, RENDER stamps the console's trace, and stage 6 lists a
real reviewable MP4. Four dispatches got there, and each failure was a real
defect rather than a flake:

1. **ALIGN.** Groq's transcription API answered `file must be one of the
   following types: [... wav ...]` for an `audio/wav` file. It reads the
   format from the uploaded *filename*, and the driver named every blob
   `"audio"` with no extension. Only ever reachable on the Gemini narration
   path, which is why it survived until `GEMINI_API_KEY` reached a runner.
2. **The encoder had no `ass` filter.** Homebrew's plain `ffmpeg` is not
   built with libass; `ffmpeg-full`, installed beside it, is. The workflow
   took whichever came first on PATH. It now probes for the filter. ffmpeg's
   error names neither libass nor the filter — it falls back to reading
   `ass=<path>` as an option assignment and says `No option name near`.
3. **The host was in the repo root.** `right_person.gif` belongs at
   `assets/character/`, so renders had been silently producing v1's look —
   footage and captions, no host.
4. **EXPORT.** A 128s render is ~42 MB and KV caps a value at 25 MiB, so the
   whole video was made and then thrown away. Blobs moved to R2 (operator
   direction, which lifts CLAUDE.md's "no R2"), written through the Worker's
   binding so the pipeline needs no R2 credential of its own.

One more defect surfaced in the audit package of the first *successful* run:
`ttsSettings` recorded the Edge voice the directive selected before the
driver was chosen, so a Gemini render named a voice that never spoke.
`auditResult.narration` had it right all along. §9's phrase is "the TTS
settings actually used", and now both fields mean it.

The first export: 117.9s, 1080x1920 h264/aac, 59.8 MB, `ready_for_review`,
narrated by Kore with the host composited and captions burned, grounded with
one citation — and 59.8 MB is more than twice what KV could ever have held.

## Running the whole pipeline locally

`PIPELINE_LOCAL=1` swaps D1-over-HTTP and KV-over-HTTP for a SQLite file
and a directory under `.local-pipeline/`, and changes nothing else — every
stage runs the code a scheduled run runs. This exists because the default
env points at the ids in `wrangler.toml`, which are the **production**
database and review queue.

```sh
set -a; . ./.env.local; set +a          # GROQ_API_KEY
export PATH="/opt/homebrew/opt/ffmpeg-full/bin:$PATH"   # an ffmpeg WITH libass

PIPELINE_LOCAL=1 npx tsx scripts/pipeline/local-seed.ts   # footage + directive
PIPELINE_LOCAL=1 npx tsx scripts/pipeline/watch.ts        # real signals
PIPELINE_LOCAL=1 npx tsx scripts/pipeline/render.ts       # one video
```

To drive it from the UI, point the run at the database `wrangler dev` is
already serving and share one store:

```sh
MF_DB=$(find .wrangler/state/v3/d1 -name '*.sqlite' ! -name 'metadata.sqlite' | head -1)
npx wrangler d1 migrations apply mythosengine --local
PIPELINE_LOCAL=1 PIPELINE_LOCAL_DB="$MF_DB" npx tsx scripts/pipeline/render.ts
npx wrangler dev --local
```

Prerequisites and their failure modes:

| Needs | If missing |
|---|---|
| `GROQ_API_KEY` | RESEARCH/SCRIPT/CRITIC cannot run — the pipeline stops and names the variable |
| **ffmpeg built with libass** | RENDER fails with `No such filter: 'ass'`. Homebrew's plain `ffmpeg` 9.0.1 bottle has no libass; `ffmpeg-full` does |
| `edge_tts` (Python) | TTS fails. `pip install edge-tts` |
| `assets-library` branch | No footage to draw from; `local-seed` refuses rather than inventing a clip |
| `GEMINI_API_KEY` | Optional. Narration falls back to Edge TTS and the audit records that it did |
| `PEXELS_API_KEY` | Optional. Stage 5 shows no preview stills and says so |
