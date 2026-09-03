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
| 1 | — | Signs in or enrols a passkey — and, scrolling, watches the pipeline build one video | — | `/auth/passkey/*` |
| 2 | How many | Lights one shard per video wanted (`# of glows = # of videos`) | — | local only |
| 3 | Topics | Each lit shard fuses with a new one; a caustic dial gives it a topic colour | — | local only |
| 4 | Ideas | A larger shard joins each video, carrying its story | `GET /console/ideas` | local only |
| 5 | Agents deployed | Watches each video's pane heal as the pipeline works | `GET /console/runs/:id`, `…/montage` | `POST /console/run-plan`, `POST /console/dispatch` (on entry) |
| 6 | Review / past work | Downloads, reads the upload sheet, marks reviewed, discards, runs it again | `GET /console/exports`, `…/:id/metadata` | mark-reviewed, discard |

### Stage 1 — the landing, and the scroll demo below it

The hero is unchanged: the shattered pane carrying "shatter into reality.",
and one button.

Below it, `src/app/stages/LandingDemo.tsx` is the only thing a signed-out
reader can be shown. It scrubs the **real** seven stages of
`scripts/pipeline/render.ts` — WATCH, RESEARCH, SCRIPT, PLAN, SOURCE, EDIT,
RENDER, under those names, because the person reading this is the person who
will later read those names in a log.

**Scrolling builds; clicking opens.** The scroll lands the sixteen fragments
of the portrait cut one slice at a time until the pane is whole — a slab,
with a video sealed inside it. From there it is the reader's move (operator
sketch, 2026-09-03):

| State | What it is | What the reader does |
|---|---|---|
| `sealed` | The unbroken slab, 3D and lit under the cursor | Click to crack it |
| `cracked` | The fragments spring apart; hovering one reveals the frame behind it | Click again to play |
| `open` | The middle clears, the video plays, the rim fragments stay live | Watch it |

Three things are worth knowing about how that is built.

**The whole cut, not the review section's eight.** `forgeLayout` picks a
deliberately sparse subset (37–48% coverage) because a review card should
read as a *card made of shards*. A sealed slab cannot: eight fragments with
holes between them read as scattered glass however they are arranged. All
sixteen `MOBILE` pieces tessellate, so at rest they meet along their real
photographed edges. The hover reveal is the review card's, class for class
(`.forge-dream`, `.shard--hot`) — a reader who signs in should recognise the
object they were just playing with. Only the content differs: the console
reveals the Pexels stills a render is sourcing from an authenticated
endpoint, and this reveals frames of the finished video, which is what a
signed-out page actually has.

**The middle clears in `open`, it does not merely fade.** The first version
pushed each fragment outward by a proportion of its own distance from the
centre, which moves rim pieces a long way and middle ones almost not at all
— so the video played under four shards sitting across it. Fragments inside
`RIM_THRESHOLD` are now cleared *and* given `pointer-events: none`, because
an invisible fragment still swallows the click meant for the play button
underneath it.

**Three transforms, one owner each.** The outer wrapper is the scroll
assembly (written every frame by `useScrollAssembly`), the inner one is the
slab state (a CSS transition), and the `.shard` itself is the cursor pose
(the spring loop in `useShardField`, live in every state including `sealed`).
They compose; none of them fights another for the same style.

Motion is hand-written (`src/app/glass/useScrollAssembly.ts`) rather than
GSAP/Lenis/three.js — CLAUDE.md forbids adding a framework without operator
instruction, the effect is two lerps in a rAF loop, and the glass is already
a DOM surface, so a WebGL renderer beside it would mean two glass
implementations that have to look identical. The technique is the standard
one and worth naming: a `sticky` stage over a tall track, progress **read**
from `getBoundingClientRect()` every frame rather than accumulated from
deltas (which drifts, and breaks on a restored scroll position), per-shard
staggered windows, and all reads and writes batched into one rAF. Native
scrolling is never hijacked, and `prefers-reduced-motion` lands every
fragment at once.

**Opacity and position ride separate curves, and that is not a detail.**
They shared one 42%-wide window at first, so the opening fragment sat at
opacity 0.01 when the reader arrived and had reached only 0.26 by the second
stage: a screen and a half of scrolling against a blank pane, under a caption
confidently announcing "STAGE 1 OF 7". Nothing was broken and it was
indistinguishable from broken — reported by the operator as "I am stuck on
this and can't move forward". A fragment now reaches full opacity in the
first third of its window and spends the rest travelling, so scrolling always
does something visible.

**The video is pipeline output** (`public/demo/`, built by
`scripts/make-demo-asset.mjs` from a real export), not a mock: a landing page
that fakes the product is the one thing this surface cannot do, given §9 is
an argument about audit trails.

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

The list is **BM25, and it is current at the moment the operator opens it**.
Those are two separate problems and they have two separate answers; a model
reranker sat here from 2026-09-02 to 2026-09-03 and solved neither, because
reordering the same corpus with the same prompt lands in nearly the same
order every visit. Removing it also took the Worker's last model call, and
its need for a Groq credential.

**`POST /console/ideas/refresh`, once per entry.** WATCH's ingest and SCORE
re-run, so the corpus holds what was published since the last scheduled poll.
Once per entry, never per topic: a video set to "let the agent choose" asks
for all seven topics at once, and seven concurrent crawls of the same feeds
is a race, not a refresh.

It polls **one source per host**, rotating to whichever that host has left
stalest, with retries on 429 switched off. That is measured, not cautious.
From one IP on 2026-09-03:

| what was sent | what came back |
|---|---|
| three concurrent reddit.com requests | `429`, `429`, `429` |
| one request | `200`, 25 entries |
| a second request 5s later | `429` |
| one request after ~45s idle | `200` |

Reddit serves roughly one RSS request per IP per 30-60 seconds. The previous
refresh fetched all five sources concurrently with three retries each — up to
nine reddit.com requests in a burst — so **every Reddit fetch on stage entry
was failing**, and the only fresh sources landing were BBC and NPR. One
request per host per entry always succeeds; three never do. Rotating by
`lastSeenAt` means three entries cover all three subreddits, and the one
polled is always the one with the most to say. Adding subreddits to
`data/sources.yml` lengthens the rotation rather than adding requests.

The feeds are `rising.rss`. A `hot` feed's newest entry measured ~4 hours old
— proven discourse, but not what is being argued about right now; `new` is
mostly posts nobody has seen yet.

**`GET /console/ideas`, per topic.** BM25 relevance (0.35), engagement
(0.25), topic-term overlap (0.15) and **recency** (0.25). That fourth weight
was added 2026-09-03 and its absence was a bug rather than a missing nicety:
the other three say nothing about time at all, so a week-old story outranked
one ingested twenty seconds earlier whenever it had marginally better term
overlap — over a candidate pool of the newest 750 scored signals, which on
this source list is several days deep. The ingest is what makes today's
stories present; this is what makes them visible.

The decay is exponential with a 12-hour half-life and is deliberately **not**
normalized across the candidate set, unlike the other three. Normalizing
would hand the newest candidate 1.0 whatever its age, so a corpus where
everything is four days old would still crown a "freshest" story and call it
recent. Absolute is the honest answer: when nothing is new, recency
contributes nothing to anyone and the other three decide. `RankedIdea`
reports `freshness` alongside `relevance` and `matchedTerms`, so why a story
is first is inspectable rather than magic.

**The refresh may not fail the screen.** A dead feed, a rate-limited host, an
ingest that returns nothing — each costs the list its freshness, is reported
in the dial's hint line, and leaves the operator able to pick a story.

One related fix: `seedSourcesFromYaml` only ever *inserted*, so editing a
`url` in `data/sources.yml` changed nothing in a database that had already
been seeded — the file and the table would disagree silently and forever.
Found moving Reddit to `rising.rss`, which would otherwise have been a no-op
in production. It now reconciles `url` and `enabled` on existing rows, and
drops that row's `etag`/`last_modified` when the URL genuinely changes: a
stored `If-Modified-Since` handed to a different feed can earn a 304 for a
document this system has never read.

A video whose operator chose "let the agent choose" is ranked across **every**
topic and the strongest signal wins; the topic that won is recorded
separately from the operator's choice, because `agent` is not a topic the
queue accepts and queuing it would 422. `score` is the only value comparable
across topics, which is what that merge sorts on.

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

**Metadata** (operator direction, 2026-09-02) opens the upload sheet for one
video, under its card: the suggested title, description and hashtags with a
copy button each, and the whole footage track as a table — every clip, the
source it came from, **the span of that source it used**, and a link that
opens the source at that second. The first line of it answers the question
that sent the operator to a CI log: whether any YouTube footage is in this
video at all, and how many of the clips are.

Two spans, kept apart on purpose. "Shot 3 runs 0:14–0:22" is a fact about
the short; "shot 3 is 41:10–42:15 of `youtube.com/watch?v=…`" is a fact
about the source, and only the second one lets a reviewer open the original
and check. Both were in `audit_json` from the day §9 was written; only the
first had ever been derivable on screen.

`GET /console/exports/:id/metadata` reads the export's own `audit_json` and
nothing else — never the live footage tables, which by design no longer
hold this video's clips. An export written before a field existed says so
in as many words rather than rendering a blank as a zero.

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
3. **The host was in the repo root.** `right_person.gif` belonged at
   `assets/character/`, so renders had been silently producing v1's look —
   footage and captions, no host. *(That asset was retired on 2026-09-01 for
   the 19-action robot character pack, and the host became its own render
   pass on 2026-09-03; the same degrade-don't-fail behaviour applies to a
   missing `assets/character/robot_character_pack/` and now to an overlay
   pass that cannot run at all.)*
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
| `GROQ_API_KEY` | Nothing that reasons can run — reranking, SCRIPT, PLAN and EDIT are on `gpt-oss-120b`, CRITIC and EXPORT's listing on `gpt-oss-20b`, and RESEARCH falls back to the first — so the pipeline stops and names the variable. The Worker needs no Groq key at all since 2026-09-03 |
| **ffmpeg built with libass** | RENDER fails with `No such filter: 'ass'`. Homebrew's plain `ffmpeg` 9.0.1 bottle has no libass; `ffmpeg-full` does |
| `edge_tts` (Python) | TTS fails. `pip install edge-tts` |
| `assets-library` branch | No footage to draw from in `gameplay` mode; `local-seed` refuses rather than inventing a clip |
| `GEMINI_API_KEY` | Optional, and it buys exactly two things. **Narration:** absent, narration runs on Edge TTS and the audit package records that it did. **RESEARCH's first attempt** (since 2026-09-02): four turns on `gemini-3.7-flash`, falling back to Groq on any failure, because RESEARCH is the one stage bounded by how much source text it can hold. No other reasoning stage reads it — an upgrade must never become a dependency, and this one briefly was |
| `uv` / `uvx` + Kinocut | Optional. EDIT is skipped and every clip is used as sourced, flagged in the audit package. `brew install uv` enables it |
| `PEXELS_API_KEY` | Optional in `gameplay` mode — stage 5 then shows no preview stills and says so. **Required** in `stock_montage` mode, where FOOTAGE fails naming this variable |

To run one video in stock-montage mode without touching the saved directive:

```sh
PIPELINE_LOCAL=1 FOOTAGE_MODE=stock_montage npx tsx scripts/pipeline/render.ts
```

`render.yml` takes the same thing as a `footage_mode` dispatch input, empty
by default so an ordinary console run uses the directive.

## Revision — 2026-09-01, hover to look inside the glass

**Stage 5's fragments are ordinary glass until the cursor is on one.**
Eight stills cross-fading on a 3.6s timer, across up to six panes, read as a
collage printed on the card rather than as glass with something behind it —
and they made the fracture, the one thing the pane exists to show, the least
legible layer on screen. Each fragment now holds **one** still for the life
of the pane and reveals it only while hovered, so the reveal is an act the
operator performs rather than an animation that runs at them.

Driven by `.shard--hot`, the class `useShardField` already writes on
`pointerenter`, so the reveal and the fragment's lift and specular are one
gesture rather than two systems each guessing at the same hover. The
image is mounted the whole time and revealed by opacity: a still that starts
loading when the cursor arrives shows nothing for the first moments of the
reveal, which is exactly the moment being looked at. The transition is
asymmetric in the same direction and for the same reason as `.shard`'s —
~160ms out, ~420ms in.

**Stage 6 keeps its stills on** (`ForgePane`'s new `reveal="always"`). That
grid is the whole library of past work and the sneak peek is what tells one
finished video from another at a glance; blanking it would make the operator
hover every card to find the one they came for. Stage 5 has the hook printed
under each pane and only a handful of them, so it loses nothing.

Stage 5's caption changed with the behaviour, and not only to mention
hovering. It used to promise that the preview stills "are not the rendered
footage — that comes from the maintained, provenance-tracked library and
never from here." As of the stock-montage mode below, that sentence is no
longer true of every run, so the stage now says previews are *not
necessarily* the rendered footage and points at the audit package, which
answers the question per video instead of in general.

## Revision — 2026-09-01, footage that is not gameplay

Operator direction: *"include footage from pexels (multiple) and stitch them
together as relevant to the script ... to see if the pipeline is capable of
making more robust videos (instead of only using gta v footage)."*

`directive.footageMode` now chooses between two strategies, and RENDER reads
it like every other directive field:

| Mode | Footage |
|---|---|
| `gameplay` (default) | One clip from the walkthrough library, looped for the whole narration. Unchanged. |
| `stock_montage` | Several licensed Pexels clips, one per script beat, each cut to that beat's own span. |

**This is not a hole in CLAUDE.md's footage rule.** The rule is that a render
never uses footage from outside the *maintained, provenance-tracked
library* — a constraint on provenance, not on genre. Every stock clip is
registered in `footage_sources`/`footage_segments` before a frame of it is
encoded, carrying its provider, clip id, page, photographer, licence and the
keyword that retrieved it; `render_footage_parts` (migration 0013) records
which second of the finished video each clip occupies; and the export names
all of it. What is *not* stored is the bytes — operator direction: ephemeral
— so a stock segment's `library_path` holds the provider's own URL, with
`footage_sources.kind` as the discriminator. `claimNextFootageSegment`
filters on that same column, so a stock clip can never satisfy a gameplay
run's claim.

The cuts land on the **argument**, not on a timer
(`src/lib/pipeline/montage-timeline.ts`): a shot acquired for beat 3 starts
on the first word of beat 3 and holds until the next shot's beat begins. A
shot that would run under 900ms is dropped and its neighbour holds through
it, so the montage never flickers, and every millisecond of the video is
covered by exactly one shot.

Two things the first real composite taught us:

- **`concat` refuses inputs that disagree** on size, pixel format, frame rate
  or sample aspect — and stock clips from different photographers agree on
  none of them. Every clip is normalised to 1080x1920, yuv420p, 30fps,
  square pixels first.
- **`-shortest` does not settle the length** once the footage track has a
  definite end: a 12.0s narration produced a 13.5s render. The narration's
  measured duration is now passed as an explicit `-t`. A single looped clip
  never hit this, because nothing in that graph ever ended. The host overlay
  pass carries the same lesson and the same fix — `overlay=...:shortest=0`
  so the character can never truncate the video, and an explicit `-t` to say
  where it actually ends.

## Revision — 2026-09-01, an ALIGN failure no longer costs the video

ALIGN used to throw. The consequence was that a complete narration, a
complete script and a complete footage montage were all discarded because
one transcription call failed — the same bad trade ARCHITECTURE.md §5.2.5
already refuses to make for RESEARCH.

A failure now costs the render its exact caption timings and nothing else.
The words are spread across the narration's *measured* duration, weighted by
word length (`src/lib/pipeline/estimate-timings.ts`), the run row records the
real error class, and the audit package carries a third state:

| `captionTiming` | Meaning |
|---|---|
| `native` | Edge TTS's own WordBoundary events. Exact. |
| `aligned` | ALIGN force-aligned a transcript of the Gemini audio. Accurate to `alignMatchRatio`. |
| `estimated` | ALIGN failed. Captions stay in step across the video and drift within a sentence. |

`estimated` is flagged in the audit summary, because a reviewer cannot tell
drifting captions from a bad take without being told which one they are
watching.

## Revision — 2026-09-01, the agents get a plan

Operator direction, in their words: *"make the agents deployed section have
a robust instruction/process for the agents to source multiple footage from
youtube/pexels (multiple from each to be diverse and sophisticated) and make
them have a proper plan to stitch the footage and clip significant/important
sections."*

### Why this was needed, in one table

The first stock montage searched Pexels for the keywords a frequency
heuristic ranked highest in a script about moral collapse:

| shot | on screen | keyword |
|---|---|---|
| 0 | a woman's face | `want` |
| 1 | a skateboarder doing a flip | `flip` |
| 2 | two people on a hill | `maybe` |
| 4 | a woman underwater | `drown` |
| 5 | a crystal mobile | `yet` |
| 6 | a ferry railing | `perhaps` |

`maybe`, `yet` and `perhaps` are function words. They ranked because the
script repeats them. Three of eight shots illustrated nothing, and no amount
of tuning the counting fixes that — "which phrase in this beat is a
*picture*" is not a counting problem.

### PLAN — the picture, and only the picture

PLAN emits one shot per beat: a filmable query, a provider, and one sentence
of intent for the reviewer. It named the host's action per shot between
2026-09-01 and 2026-09-03 and no longer does — the host is a fixed cycle now
(see **HOST** below), so there is nothing about it left to decide, validate or
correct.

On `politics`, `tech`, `science` and `ai`, PLAN is told to prefer `youtube`
over stock, and SOURCE raises its download budget from 2 to 4 to honour it.
There is no stock clip of the actual hearing.

### HOST — a second pass, and nothing chooses it

RENDER hands back a **finished, publishable Short with no host in it**:
footage cut to the beats, narration, burned-in captions. The character goes on
top of that in its own ffmpeg pass (`src/lib/drivers/character-overlay-ffmpeg.ts`).

The performance is fixed (operator direction, 2026-09-03). The host waves
hello, runs the pack's other 17 actions once through in manifest order, loops
that 50.5-second cycle for as long as the video lasts, and waves goodbye. The
only rule is that the first and last actions are the waves.

Three things follow from making it a separate pass:

- **A failed overlay costs the host, not the video.** A missing pack, an
  unreadable manifest, an encoder error: the export is the hostless render,
  flagged with `characterAbsentReason`. Inside the render's filtergraph the
  identical failure took the video with it.
- **One input instead of forty-four.** A 128-second video is ~44 actions. As
  `-i` arguments that is 44 concurrent decodes of lossless RGBA on the
  operator's own machine; through ffmpeg's concat demuxer it is one input.
  That works because every pack MOV is `png / 640x680 / rgba / 12fps` and PNG
  is all-intra, so the one `outpoint` trim that lands the wave on the end of
  the video is frame-exact.
- **The host sits on top of the captions, safely.** The captions are ASS
  `Alignment: 5`, so they sit at the vertical middle of the frame; the host
  occupies 10%–44% of the height from the bottom. They do not meet. Moving
  either one is a change that has to be checked against the other.

The track is built to run *past* the video's end rather than stop short of it,
and the pass cuts it with an explicit `-t`. An overshoot clips up to 0.8s off
the goodbye wave's tail; an undershoot would leave the last moment of the
video with no presenter, which reads as a crash. Audio is stream-copied, so
the second encode costs the picture one generation and the narration nothing.

Two consequences that were accepted rather than overlooked: the host cuts on
its own 12fps cadence rather than on the footage's, and the pack's silent
actions (idle, nod, shrug, thinking) play under continuous narration. Both
follow directly from "every animation in sequence".

### PLAN

`src/lib/pipeline/shot-plan.ts`, prompt at `prompts/shot-plan.v1.md`, on the
20b model. It turns the script into an ordered shot list — `{ beatIndex,
intent, query, source }` — and it is the one place in this pipeline where a
model is spent on footage, because it is the one place with real ambiguity
(CLAUDE.md's rule about where tokens go).

Deterministic validation follows it. `isFilmableQuery` rejects a query that
is a single word, or that is abstract all the way through once articles and
prepositions are stripped. Rejected shots are **dropped, not repaired**: a
montage with one shot fewer is fine, and a query invented to patch a hole
would be exactly the filler the stage exists to stop.

The first live run of it, on an F1 contract story, planned: *clock showing
year 2030 · pit lane car wrapped in red tape · pit crew pouring fluid into
car · hand holding signed contract · race car on ladder · pit crew with
fewer tools · calendar with dates highlighted.* Every one names something a
camera can point at.

A failed PLAN falls back to the old keyword extraction, marked degraded —
never fatal, the same contract §5.2.5 gives RESEARCH. The fallback gets the
same filmability filter, so it cannot reintroduce `maybe`.

### `viral` never reaches the model

Operator direction: a viral video's background is always a **GTA 6
walkthrough**. Once the topic has decided the footage there is nothing left
for a model to decide, so `viral` short-circuits `planShots` entirely and
spends no token. Which second of the run to take is answered by motion
scoring and chance: windows are drawn at random from the top motion-scored
shortlist, after a head/tail buffer, which is what the operator asked for
("clipped from random locations with buffers at the beginning and end") and
what stops three videos opening on the same twenty seconds.

### SOURCE

`src/lib/footage/source-agent.ts` executes the plan.

- **Pexels** answers "an ordinary scene, shot well" — the returned clip is
  already the whole shot.
- **YouTube** answers "the actual thing", and a YouTube result is an hour of
  video with one usable minute in it. So the window is motion-scored rather
  than taken from the front, which is where a channel puts its intro.
- **Sourcing is open.** `ChannelTopVideoRequest` gained a free-form `query`
  and the maintained-channel rule (migration 0008) no longer binds this
  path — operator decision, this session, recorded because it is a real
  change to the footage policy. The weekly FOOTAGE REFRESH is unchanged.
- **Two YouTube downloads per render, hard.** Each is potentially a gigabyte
  through a converter site on the operator's own connection. A shot past the
  cap falls back to Pexels — a worse picture and a finished video — and the
  reason is reported rather than the shot vanishing.
- **A cache hit does not spend a download slot.** It costs no bandwidth and
  no converter round trip, so counting one against the ceiling would refuse
  footage already on disk.

### Stage 5 shows it happening

`shot_plans` (migration 0014) holds every shot and its status. Stage 5
renders it under each pane: source, query, intent, and how far it got —
`planned → searching → downloading → clipped → in the video`.

Every status is a row the pipeline wrote **after** doing the thing. There is
no progress bar and no percentage here, for the same reason there is none
anywhere else on this stage: neither would be a fact.

## Revision — 2026-09-01, nothing is permanent

Operator direction: *"don't make any footage permanent, delete them after
use (both game footage and pexel footages) ... delete rendered videos after
2 days ... At the end no sourced footage should survive."*

- **Exports live two days**, not three, and the deadline is now real. The
  sweep ran only at the top of RENDER, and this system makes videos only
  when the operator dispatches a run — so "expires in two days" meant
  "expires whenever you next make a video". WATCH is hourly and now runs the
  same sweep. Existing exports keep the window they were stamped with;
  shortening a window the operator was already told about would delete a
  video out from under them.
- **Footage rows die with the video they were sourced for.** Retiring an
  export drops its `render_footage_parts` and every `footage_segments` row
  no reviewable video still points at. Provenance outlives the video by
  exactly zero days — not one more, because nothing needs it; not one less,
  because §9 requires it for as long as there is something to review.
- **One stub row per render survives, structurally.**
  `renders.footage_segment_id` is NOT NULL and restricting, and the render
  row has to stay because `pickVoicesForToday` reads the day's renders to
  rotate. A montage's clips all go; its first clip leaves ~200 bytes of row.
  No media survives either way — the bytes were never stored.
- **Clip bytes never outlive the run.** Every clip is written into the
  render's work directory, which is removed in a `finally`. Nothing is
  committed to `assets-library` any more.
- **One exception, and it is the operator's:** downloaded YouTube *sources*
  live in `.footage-cache/` for 24 hours (`src/lib/footage/source-cache.ts`),
  swept by age at the top of every render, so a viral run does not re-pull
  1.6 GB hourly. No clip and no Pexels byte is ever written there.

`directive.footageMode` was removed in the same pass. It had one session of
life and the topic decides the strategy now, so it was a knob with nothing
behind it.

### What the degraded PLAN path does, and why it looks like that

PLAN runs last of the four reasoning stages, on the same Groq model and
behind the same 8,000-token-per-minute bucket as the three before it — so a
run that has already spent RESEARCH, SCRIPT and CRITIC can find PLAN rate
limited, which happened on the first day it existed. (It spent a few hours
on the Gemini ladder on 2026-09-01, with RENDER pausing 61s between stages
to stay under 5 requests/minute; the operator reverted that the same day
after the ceiling cost a render.) Since 2026-09-02 a RESEARCH that lands on
Gemini leaves that bucket — and the 200K/day behind it — untouched by the
hungriest stage of the run, which makes PLAN's degraded path rarer without
making it any less necessary: RESEARCH falls back to Groq often enough that
the contention it was written for is still real. The fallback therefore matters as much as
the stage, and it took three attempts to get right:

1. **Keyword extraction, unfiltered.** Produced `maybe`, `yet`, `perhaps`.
   This is what motivated PLAN in the first place.
2. **Keyword extraction, single words allowed through the filmability
   check.** Produced `ever`, `there's`, `it's`, `see`, `gets` — function
   words that are simply not in the denylist, because a denylist cannot
   enumerate them. Reverted within the hour.
3. **What it does now.** Only phrases clearing the *same* two-content-word
   bar the model is held to, topped up to a montage with a short list of
   neutral B-roll ("city street crowd walking", "rain on a window pane").

The third makes no claim to illustrate the argument, and the plan is marked
`origin: "heuristic"` so the audit package says the video was not planned.
That is a much smaller lie than a chessboard standing in for "perhaps", and
it is the difference between a degraded video and a misleading one.

### One known lag

A render killed mid-flight leaves its run pick `claimed`. `releaseStrandedPicks`
(`db/run-picks.ts`) requeues it, but only once the run rows behind it have
been reaped — **up to 45 minutes** (`STALE_RUN_THRESHOLD_MS`). That threshold
is not shortened on purpose: releasing a pick a live render is still working
on would produce two videos about the same story, which is worse than
waiting. A pick whose signal has since been scripted is never requeued at
all, for the same reason.

### `viral` is gameplay or nothing

`sourceShots` does **not** fall a viral shot back to Pexels the way it does
for every other plan. The operator's direction is that a viral video's
background is *always* a GTA 6 walkthrough, and a stock sunset standing in
for it would quietly break that promise in a way only a reviewer watching
the finished video would catch.

The cost is real and worth stating: if the converter is down or YouTube
returns nothing for the query, a viral render fails at SOURCE and says so.
Every other topic degrades to stock instead.
