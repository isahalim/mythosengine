# Plan v2 — the two-host dialogue format

**Status:** proposed, 2026-08-31. Nothing here is built yet. Supersedes the
single-narrator format described in `ARCHITECTURE.md` §5 once accepted.

---

## 1. What actually changes

Today the system makes **one** 47-second video: a single synthetic narrator
reading 130–170 words over muted gameplay, with word-level captions.

The new format is a **two-host dialogue show**. Every video, on every topic,
is a conversation between the same two recurring characters — one learning,
one teaching. That single decision cascades through every stage: script
generation produces turns rather than prose, TTS synthesizes per-turn with
two voices, and the renderer composites two chroma-keyed characters over the
footage and marks who is speaking.

It also removes the format's hardest constraint. A monologue gets boring at
about a minute; a dialogue that builds, disagrees and re-explains sustains
three — which is exactly the YouTube Shorts ceiling.

| | Now | v2 |
|---|---|---|
| Voices | 1 (Edge TTS) | 2 (Gemini TTS, per-turn) |
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
  white background.
- **Background removal:** same technique keyed on white. **Untested — the
  asset needs `PEXELS_API_KEY`, which is a GitHub secret and not present
  locally.** If the character contains white, `colorkey` will punch holes in
  it and this needs a matte instead. Measure before building on it.
- **Voice:** male.
- **Character:** asks the question the viewer is actually thinking, pushes
  back when an explanation is too neat, restates in his own words — often
  slightly wrong, which earns the correction.

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

**TTS** → per turn, not per script. Each turn is synthesized alone with its
speaker's voice and the clips concatenated. This is deliberately *not*
Gemini's multi-speaker mode: synthesizing per turn gives exact turn
boundaries for free, lets each turn be aligned independently, and makes one
failed turn a retry instead of a lost script.

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
delete the caption feature this change is meant to enhance. So each turn's
audio is force-aligned with Groq Whisper, which already exists in the
codebase (`groq-whisper.ts`) and needs one extension —
`timestamp_granularities[]=word`, where it currently requests only segments.

---

## 5. New drivers

Each follows the Phase 1 pattern: `Result<T, DriverError>`, typed errors,
`AbortSignal` timeouts, contract tests against a local mock.

| Driver | Purpose | Notes |
|---|---|---|
| `tts-gemini.ts` | expressive narration | 24kHz PCM; **falls back to Edge TTS** when quota is exhausted |
| `llm-gemini.ts` | PLAN and RESEARCH | stronger models where reasoning matters |
| `footage-pexels.ts` | stock video by query | licensed, API-clean |
| `footage-youtube-news.ts` | real event footage | reuses the yt-dlp driver + `YOUTUBE_COOKIES` |

**Quota honesty:** Google no longer publishes free-tier TTS rate limits in
its docs — they are per-account in AI Studio. Nothing here is designed
around a number that cannot be verified. The Edge TTS fallback is the
mitigation, and it is not optional.

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
2. **Dialogue format** — script turns, per-turn TTS, Whisper alignment, two-character composite.
3. **News + Pexels** — the two new footage drivers, stitching, cookies.
4. **PLAN stage** — shot list, keyword highlighting, transitions.
5. **Runner + cleanup** — launchd wake-start, auto-delete after render.

---

## 9. Open questions

- **The left character is unverified.** Its white background may not key
  cleanly. Measure before it is built on.
- **Three minutes of dialogue is a lot of TTS.** Six videos × 3 minutes is
  ~18 minutes of synthesis per run against an unpublished free-tier quota.
  The fallback path will be exercised routinely, not rarely.
- **Whisper alignment costs a Groq call per turn.** A 3-minute video may have
  20+ turns. Batching or aligning the concatenated audio once may be
  necessary; per-turn is the correct starting point because it is simplest to
  reason about.
