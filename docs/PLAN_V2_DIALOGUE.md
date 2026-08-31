# Plan v2 — the two-host dialogue format

**Status:** proposed, 2026-08-31; revised the same day after measuring the
learner asset and receiving the operator's AI Studio rate-limit export.
Nothing here is built yet. Supersedes the single-narrator format described in
`ARCHITECTURE.md` §5 once accepted.

**What the revision changed:** the learner keys cleanly on white and its
threshold is settled (§2); the TTS design flipped from per-turn to one
multi-speaker request because the free tier allows 10 TTS requests a day
(§4, §5); and the learner asset turns out to be 25 faces rather than one,
which is the plan's one genuinely open product question (§2).

---

## 1. What actually changes

Today the system makes **one** 47-second video: a single synthetic narrator
reading 130–170 words over muted gameplay, with word-level captions.

The new format is a **two-host dialogue show**. Every video, on every topic,
is a conversation between the same two recurring characters — one learning,
one teaching. That single decision cascades through every stage: script
generation produces turns rather than prose, TTS synthesizes both voices in
one pass, alignment recovers the turn boundaries, and the renderer composites
two chroma-keyed characters over the footage and marks who is speaking.

It also removes the format's hardest constraint. A monologue gets boring at
about a minute; a dialogue that builds, disagrees and re-explains sustains
three — which is exactly the YouTube Shorts ceiling.

| | Now | v2 |
|---|---|---|
| Voices | 1 (Edge TTS) | 2 (Edge TTS default, Gemini multi-speaker upgrade) |
| Length | 47s | 60–180s |
| Script | prose, 130–170 words | turns, 190–520 words |
| Footage | game only | game · Pexels stock · YouTube news |
| Captions | word-level, uniform | word-level + keyword highlighting |
| Topics | viral/controversial | + news · + concept teaching |
| Videos/run | 3, fixed | variable, operator chooses |

---

## 2. The two hosts

Both appear in **every** video regardless of topic. They are the show's
identity, so their profiles are fixed content, not per-video generation.

### Right — the teacher

- **Asset:** `right_person.gif`, 800×600, 70 frames, 5.6s loop.
- **Background removal:** measured, not guessed. The background is a
  perfectly flat `#e5505c` at every corner; her face is `#e48080` — the same
  red channel, 48/36 apart in green/blue. `colorkey=0xe5505c:0.10:0.0`
  removes the background cleanly with her face, blush, glasses and hair
  intact. **0.14 begins eating her face and 0.20 destroys it**, so 0.10 is
  the ceiling, not a starting point. Verified by compositing over a contrast
  colour and sampling pixels, 2026-08-31.
- **Voice:** female.
- **Character:** explains by analogy, concedes good objections, never
  condescends. Answers "why", not just "what".

### Left — the learner

- **Asset:** Pexels *Colorful Abstract Faces Loop Animation* (id 34857280),
  1920×1440, 60fps, 17.65s, white background. No `PEXELS_API_KEY` was needed
  to obtain it — the page blocks plain requests, but the repo's existing
  Playwright path reads the public CDN URL off it
  (`videos.pexels.com/video-files/34857280/14773032_1920_1440_60fps.mp4`).
  The key is still required for the *footage* driver in §5.
- **Background removal:** `colorkey=0xffffff:0.30:0.0`. Measured, 2026-08-31.
  The background is pure `#ffffff` at every corner in every frame. The
  constraint is the **opposite** of the teacher's: low thresholds are the
  problem, not high ones. Below ~0.20 the antialiased edge leaves a visible
  cream halo around the whole silhouette; the key itself never bleeds into
  the character.

  | similarity | subject retained | holes in subject | verdict |
  |---|---|---|---|
  | 0.01 | 100% | 2.3% | cream halo, unusable |
  | 0.20 | 91.2% | 4.2% | halo mostly gone |
  | **0.30** | **89.3%** | **5.1%** | **clean, no halo** |
  | 0.40 | 86.6% | 11.3% | erosion starting |
  | 0.50 | 44.2% | 27.2% | destroyed — cyan is within 0.50 of white |

  0.20–0.30 is a flat plateau, so 0.30 sits at the top of it with the cliff
  0.20 away — a far wider margin than the teacher's 0.10 ceiling. Measured by
  flood-filling the keyed region from the frame border, so "holes" means
  white *enclosed by* the character, which is what actually punches through.
- **Holes are intentional.** Operator decision, 2026-08-31: the ~5% of the
  character that keys out is wanted, so the footage shows through the face.
  This is why the wider threshold is free — there is nothing to protect.
- **Crop:** `crop=472:704:744:372`. The character occupies only ~6% of the
  source frame and drifts within it; that box is the union of its bounding
  box over all 1059 frames. Compositing the full 1920×1440 layer would be
  almost entirely empty.
- **Voice:** male.
- **Character:** asks the question the viewer is actually thinking, pushes
  back when an explanation is too neat, restates in his own words — often
  slightly wrong, which earns the correction.

#### Unresolved: this asset is 25 faces, not one

The keying question is settled, but measuring it surfaced a separate problem
the plan has to answer before the renderer is built.

The clip is not one character animating. It is **25 distinct drawings**
cycling at roughly four per second, reshuffled over the 17.65s loop — mean
subject colour jumps by 50–118 (of 765) between quarter-second samples, with
no stable run longer than about 0.5s. Several of them are different people:
different hair, different palettes, some barely readable as a face.

That contradicts the premise directly above it — that the hosts are the
show's fixed identity — and at four changes per second it will fight the
captions for attention across a 60–180s video.

The usable finding: **the first 2.5s is one consistent character.** Those ten
drawings are the same cyan-green figure at varying angles, which is exactly
what a talking head wants, and its palette is a clean complement to the
teacher's salmon-red. Options, cheapest first:

1. **Loop `0.00–2.50s` only** — one character, still alive, no new asset.
   Recommended.
2. **Freeze one drawing** and animate it externally (bob, scale, mouth
   overlay). Most control, least life.
3. **Keep the full loop** and accept the learner as a deliberately shifting
   "anyone" face. Defensible thematically — the learner *is* the audience
   proxy — but it is a different product decision, not the one §2 states.
4. **Different asset.** Only if none of the above reads well in motion.

### Why this shape

The learner is the audience's proxy. The teaching lands because someone on
screen misunderstands first. This is also what lets a script criticise its
own claims without the video sounding incoherent — disagreement belongs to a
character, not to the narrator.

---

## 3. Video tracks

The operator picks a topic per video; the track follows from it.

| Track | Topics | Footage |
|---|---|---|
| **Viral** | trending, polarizing discourse (today's behaviour) | maintained game library |
| **News** | politics · tech · science · AI · philosophy | Pexels stock + YouTube news, balanced |
| **Concept** | teaching an idea | Pexels stock, illustrative |

Footage policy for News (operator decision, 2026-08-31): roughly even split.
Stock carries abstract or emotional beats; real news footage carries specific
events that stock cannot honestly depict.

---

## 4. Pipeline stages

### Changed

**SCRIPT** → emits `DialogueScript`: an ordered list of turns
`{ speaker: "learner" | "teacher", text }`, targeted at a requested duration
rather than a word count. Word count becomes derived, and the validation
becomes "does the estimated read time land in range".

**TTS** → **one multi-speaker request per video.** The whole dialogue goes to
Gemini in a single call with both speakers labelled, and comes back as one
audio file.

This reverses what this plan said on 2026-08-31, and the reason is a measured
number rather than a preference — see *Quota reality* in §5. Per-turn
synthesis costs one request per turn; the free tier allows **10 TTS requests
per day, total**. A single 20-turn video is twice the entire daily budget. It
is not a tuning problem, it is arithmetic, and per-turn is off the table for
as long as this runs on the free tier.

What that costs us, honestly: turn boundaries no longer come for free, and a
failure loses the whole script instead of one turn. Both are absorbed by
ALIGN below — the same Whisper pass that recovers word timings recovers turn
boundaries too, by matching the known turn text against the returned word
sequence. Retries are budgeted rather than free: 6 videos leaves 4 spare
requests a day.

**RENDER** → composites two keyed character loops over the footage, dims the
non-speaking host, cuts between footage shots on the planner's timings, and
draws captions with per-word highlighting.

### New

**PLAN** (between CRITIC and TTS) — produces the shot list, which is the
artifact that makes everything else possible:

```
{ segments: [ { turnIndex, footageQuery, sourceKind, startS, endS,
                transition, highlightWords[] } ],
  hook, openEndedQuestion, targetDurationS }
```

Nothing downstream guesses. The renderer reads this; it does not decide.

**ALIGN** — Gemini TTS returns audio and **no timings**, which is the single
most important technical fact in this plan: the current word-level captions
come entirely from Edge TTS's `WordBoundary` events. Switching naively would
delete the caption feature this change is meant to enhance. So the audio is
force-aligned with Groq Whisper, which already exists in the codebase
(`groq-whisper.ts:55`) and needs one extension —
`timestamp_granularities[]=word`, where it currently requests only segments.

ALIGN now carries more weight than when it was written, because multi-speaker
TTS means it is the *only* source of turn boundaries as well as word timings.
It gets both from one pass: Whisper returns the word sequence, and the turn
texts are already known, so the boundaries fall out of matching one against
the other. Mis-splitting a turn mis-attributes a line to the wrong host on
screen, so this needs a real test, not a smoke test.

One request per video, not per turn — which also settles the open question
about alignment cost. It was never a choice; concatenated audio is all there
is to align.

---

## 5. New drivers

Each follows the Phase 1 pattern: `Result<T, DriverError>`, typed errors,
`AbortSignal` timeouts, contract tests against a local mock.

| Driver | Purpose | Notes |
|---|---|---|
| `tts-gemini.ts` | expressive narration | 24kHz PCM, multi-speaker, one call per video; **Edge TTS is the default path**, this is the upgrade — see *Quota reality* |
| `llm-gemini.ts` | PLAN and RESEARCH | stronger models where reasoning matters |
| `footage-pexels.ts` | stock video by query | licensed, API-clean |
| `footage-youtube-news.ts` | real event footage | reuses the yt-dlp driver + `YOUTUBE_COOKIES` |

### Quota reality

The number this plan said could not be verified now is. From the operator's
own AI Studio rate-limit export for project *Mythos Engine* (free tier,
28-day window), 2026-08-31:

| Model | RPM | TPM | RPD |
|---|---|---|---|
| Gemini 2.5 Flash TTS | 3 | 10K | **10** |
| Gemini 3.1 Flash TTS | 3 | 10K | **10** |
| Gemini 2.5 Pro TTS | 0 | 0 | 0 — not on the free tier |

Three consequences, in order of how much they hurt:

1. **10 requests per day is the binding limit**, and it is per day, not per
   run. It forces multi-speaker (§4) and rules out per-turn synthesis
   entirely. A 6-video run spends 6 of the 10.
2. **Pro TTS is unavailable.** The expressiveness argument for moving off
   Edge TTS at all rests on Flash TTS, not the better model.
3. **10K TPM is unverified against a 3-minute response.** Output audio tokens
   count toward it, and this plan asks for up to 180s of speech in one call.
   If that exceeds the window, the choices are a shorter ceiling or splitting
   the call — and splitting spends the one budget we cannot grow. **Measure a
   full-length request before the renderer depends on it.**

So the Edge TTS fallback is not a safety net that rarely fires — on any day
with more than one run, or any day that burns retries, it is the path. Build
it as the default and Gemini as the upgrade, not the reverse. Edge TTS also
still emits `WordBoundary` natively, so the fallback path needs no ALIGN call
at all.

### The cookies decision

`YOUTUBE_COOKIES` is back in the repository secrets, and the yt-dlp driver
already accepts a cookie file. This is what makes YouTube news footage
possible, and it may also unblock GitHub-hosted runners. It attaches a real
YouTube account to automated downloading — accepted by the operator on
2026-08-31 for the news track. The cookie file is written from the secret at
job start and deleted at job end; it is never committed, logged, or read
outside the driver.

---

## 6. Model routing

| Stage | Model | Why |
|---|---|---|
| WATCH scoring | Groq `gpt-oss-20b` | cheap, high volume |
| RESEARCH | Groq `gpt-oss-20b` | tool-calling over BM25, already built |
| SCRIPT | Gemini | dialogue with two distinct voices is the hardest generation here |
| CRITIC | Groq `gpt-oss-120b` | unchanged |
| PLAN | Gemini | shot list needs real reasoning about what a shot should show |
| Metadata | Groq `gpt-oss-20b` | unchanged |

Groq's binding limit is tokens-per-day; Gemini's is requests-per-minute.
Splitting across both providers is what makes a 6-video run affordable at
all.

---

## 7. Console overhaul

The console stops being a dashboard and becomes a guided sequence. Because
the operator is present for the whole run, their laptop is available as the
self-hosted runner — which is what makes footage sourcing work at all. The
UI and the infrastructure fix are the same decision.

### Steps

1. **How many videos** — variable, not a fixed 3.
2. **Topic per video** — viral · politics · tech · science · AI · philosophy · concept.
3. **Ranked ideas** — RAG research runs per topic, returns ranked candidates, operator picks one each.
4. **The agents work** — planning, scripting, sourcing, rendering. No technical detail surfaced.
5. **Review and download** — existing queue, restyled.

### The waiting screen

Step 4 is minutes long, so it is the screen that needs the most design, not
the least. As the planner works, keywords from the emerging plan surface one
at a time; each pulls a matching Pexels clip and fades it through the
video's card, then out, then the next. The operator watches the film assemble
itself conceptually instead of watching a spinner. The clips shown are drawn
from the same Pexels source the video will use, so this is a preview, not a
decoration.

### Visual direction

Operator-specified, and followed exactly:

- Shattered-glass hero on **white** (21st.dev, "Broken by Design").
- On login the glass **disperses to the edges**, leaving a white workspace.
- Large soft **rainbow gradient spheres** drift slowly through the centre
  like a lava lamp, colours mixing where they overlap — the workspace where
  controls appear progressively.
- Glassmorphism, rainbow soft glows, clean modern elements throughout.
- Glass **reassembles** when every video is reviewed, when the day rolls
  over, or on demand.

`TWENTYFIRST_API_KEY` is present in `.env.local`. The spheres should be
shader-driven rather than stacked blurred divs — a real gradient mix at the
intersections is the whole point of the metaphor.

---

## 8. Sequencing

Phase A (runner, auto-delete) is absorbed: sourcing happens during the
operator's walkthrough, and cleanup happens once a video is built.

1. **Console overhaul** — the shell, the five steps, the visual direction.
2. **Dialogue format** — script turns, multi-speaker TTS, Whisper alignment (words *and* turn boundaries), two-character composite.
3. **News + Pexels** — the two new footage drivers, stitching, cookies.
4. **PLAN stage** — shot list, keyword highlighting, transitions.
5. **Runner + cleanup** — launchd wake-start, auto-delete after render.

---

## 9. Open questions

Two of the three below were closed on 2026-08-31; they are kept with their
answers so the reasoning stays legible.

- ~~**The left character is unverified.**~~ **Closed.** `colorkey` on white
  works, with a wider margin than the teacher had — `0xffffff:0.30:0.0`, full
  numbers in §2. The holes it punches are wanted, not tolerated.
- ~~**Whisper alignment costs a Groq call per turn.**~~ **Closed, by being
  overtaken.** Multi-speaker TTS returns one audio file, so there is one
  alignment call per video and nothing to batch.
- **Does a 180s multi-speaker request fit in 10K TPM?** The one number in §5
  still unmeasured, and the plan's length ceiling depends on it. Measure
  before the renderer is built on it.
- **Which learner asset?** The clip is 25 faces, not one character (§2).
  Recommendation is to loop only its first 2.5s; the operator has not ruled.
- **Gemini TTS is now a hard cap on throughput, not a quality choice.** 10
  requests/day means one 6-video run per day with 4 retries spare. A second
  run in a day is an Edge TTS run. If that is too tight, the question is
  whether Gemini earns its place at all — Edge TTS is free, unmetered, and
  the only path that still emits word timings natively.
