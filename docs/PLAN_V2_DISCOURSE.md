# Plan v2 — the single-host discourse format

**Status:** proposed, 2026-08-31; revised twice the same day. Nothing here is
built yet. Supersedes the single-narrator format described in
`ARCHITECTURE.md` §5 once accepted.

**The dialogue moved inside one head.** The format is still discourse — it
still poses, resists, concedes and reframes — but one host performs the whole
argument as self-talk rather than two hosts splitting it. Operator decision,
2026-08-31, to hold the token and quota budget down. Everything the two-host
version bought is kept; the second body and the second voice are what go.

**Revision history, same day:**

1. Measured the learner asset's white key and read the operator's AI Studio
   rate-limit export. TTS flipped from per-turn to a single call, because the
   free tier allows 10 TTS requests a day (§4, §5).
2. **Cut to one host** (§2). This closes the learner-asset question outright —
   that asset is no longer used — and simplifies SCRIPT, TTS and RENDER.

---

## 1. What actually changes

Today the system makes **one** 47-second video: a single synthetic narrator
reading 130–170 words over muted gameplay, with word-level captions.

The new format is a **discourse show with one host**. Every video, on every
topic, is the same recurring character thinking a question through out loud —
posing the naive version, trying an answer, catching the hole in it, and
reframing until it lands. That single decision cascades through every stage:
script generation produces argumentative *beats* rather than prose, TTS
synthesizes one expressive voice, alignment recovers word timings, and the
renderer composites one chroma-keyed character over the footage.

It also removes the format's hardest constraint. Straight narration gets
boring at about a minute; an argument that builds, doubts itself and
re-explains sustains three — which is exactly the YouTube Shorts ceiling.
Note what is load-bearing there: it is the *disagreement*, not the second
voice. One mind changing its own position carries a video as well as two
people disagreeing, and costs half as much to make.

| | Now | v2 |
|---|---|---|
| Voices | 1 (Edge TTS) | 1 (Edge TTS default, Gemini single-speaker upgrade) |
| Length | 47s | 60–180s |
| Script | prose, 130–170 words | beats, 190–520 words |
| Footage | game only | game · Pexels stock · YouTube news |
| Captions | word-level, uniform | word-level + keyword highlighting |
| On screen | no character | one keyed character |
| Topics | viral/controversial | + news · + concept teaching |
| Videos/run | 3, fixed | variable, operator chooses |

---

## 2. The host

She appears in **every** video regardless of topic. She is the show's
identity, so her profile is fixed content, not per-video generation.

- **Asset:** `right_person.gif`, 800×600, 70 frames, 5.6s loop.
- **Background removal:** measured, not guessed. The background is a
  perfectly flat `#e5505c` at every corner; her face is `#e48080` — the same
  red channel, 48/36 apart in green/blue. `colorkey=0xe5505c:0.10:0.0`
  removes the background cleanly with her face, blush, glasses and hair
  intact. **0.14 begins eating her face and 0.20 destroys it**, so 0.10 is
  the ceiling, not a starting point. Verified by compositing over a contrast
  colour and sampling pixels, 2026-08-31.
- **Voice:** female, one voice for the whole script.
- **Character:** curious out loud. She asks the question the viewer is
  actually thinking, tries the obvious answer, catches why it is too neat,
  and explains by analogy once she has earned it. She concedes to herself.
  She never lectures, because she is not addressing a student — she is
  working something out.

### The dialogue is internal now

The two-host version put the misunderstanding in a second character. This one
puts it in the same character, earlier in time: she is wrong first, then
right. That is what keeps the teaching from sounding like a lecture, and it
is still what lets a script criticise its own claims without sounding
incoherent — the disagreement belongs to a *moment*, not to a narrator making
flat assertions.

It also removes a whole class of failure. With two hosts, mis-splitting a
turn puts a line in the wrong mouth on screen, which is the kind of error a
viewer notices immediately. With one host there is no wrong mouth.

### What was dropped

The Pexels *Colorful Abstract Faces* clip (id 34857280) planned as the second
host is **no longer used**. Measuring it settled two things worth keeping on
record, in case a second character is ever revisited:

- It keys cleanly on white at `colorkey=0xffffff:0.30:0.0`, with the
  *opposite* constraint to the teacher's — below ~0.20 the antialiased edge
  leaves a cream halo, erosion starts at 0.35, and 0.50 destroys it because
  cyan falls inside the key. 0.20–0.30 is a flat plateau.
- It is **25 distinct drawings** cycling at roughly four per second, not one
  character. Only its first 2.5s is a single consistent figure.

The second point is the better reason it was never going to work as a
recurring identity, independent of the budget decision that cut it.

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

**SCRIPT** → emits `DiscourseScript`: an ordered list of beats
`{ move, text }`, targeted at a requested duration rather than a word count.
Word count becomes derived, and the validation becomes "does the estimated
read time land in range".

`move` is what replaces the second speaker, and it is the single most
important field in this plan. With two hosts the dynamic came free from
alternating voices; with one host it has to be made explicit, or the script
degrades into the flat narration this format exists to escape:

| move | what the beat does |
|---|---|
| `question` | poses the naive version the viewer actually holds |
| `attempt` | tries the obvious answer, in good faith |
| `pushback` | catches the hole in that answer |
| `reframe` | restates the problem in better terms |
| `land` | the payoff the reframing earned |
| `open` | the closing question, deliberately unresolved |

Validation is structural, not just length: a script that never leaves
`attempt` and `land` is a lecture and should fail the gate. **At minimum one
`pushback` must sit between an `attempt` and a `land`** — that ordering *is*
the format. `move` also gives every downstream stage something to vary on:
TTS delivery, caption emphasis, and where the footage cuts.

**TTS** → **one single-speaker request per video.** The whole script goes to
Gemini in one call and comes back as one audio file.

One call per video is forced by quota, not chosen — the free tier allows
**10 TTS requests per day, total** (§5). Per-beat synthesis would cost one
request per beat, so a single 20-beat video would be twice the entire daily
budget. That much was already true of the two-host plan.

What the cut to one host changes is that this is now Gemini's *ordinary*
single-speaker mode rather than its multi-speaker mode — better supported,
one voice to configure, and no speaker labels to get wrong.

**Expressiveness is the reason Gemini is here at all**, and with one request
per video it has to come from within that request. Gemini TTS accepts a
natural-language style instruction, so the `move` of each beat is carried
into the call as inline direction — a `question` read differently from a
`pushback`. **Untested.** Whether inline direction actually shifts delivery
mid-utterance is the thing to measure first, alongside the TPM question in
§5. If it does not, the fallback is one flat style for the whole script,
which is still expressive, just not per-beat.

**RENDER** → composites one keyed character loop over the footage, cuts
between footage shots on the planner's timings, and draws captions with
per-word highlighting.

### New

**PLAN** (between CRITIC and TTS) — produces the shot list, which is the
artifact that makes everything else possible:

```
{ segments: [ { beatIndex, footageQuery, sourceKind, startS, endS,
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

One request per video, not per beat — which settles the old open question
about alignment cost. It was never a choice; a single audio file is all there
is to align.

ALIGN is also the only source of **beat boundaries**, recovered the same way:
Whisper returns the word sequence, the beat texts are already known, so the
boundaries fall out of matching one against the other. Cutting to one host
lowers the stakes here considerably. With two hosts a mis-split put a line in
the wrong mouth on screen; here the worst case is a footage cut landing a
beat early or late. Still worth a real test, but it is no longer the sharpest
edge in the pipeline.

---

## 5. New drivers

Each follows the Phase 1 pattern: `Result<T, DriverError>`, typed errors,
`AbortSignal` timeouts, contract tests against a local mock.

| Driver | Purpose | Notes |
|---|---|---|
| `tts-gemini.ts` | expressive narration | 24kHz PCM, single-speaker, one call per video; **Edge TTS is the default path**, this is the upgrade — see *Quota reality* |
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
   run. It forces one call per video (§4) and rules out per-beat synthesis
   entirely. A 6-video run spends 6 of the 10.
2. **Pro TTS is unavailable.** The expressiveness argument for moving off
   Edge TTS at all rests on Flash TTS, not the better model.
3. **10K TPM is unverified against a 3-minute response.** Output audio tokens
   count toward it, and this plan asks for up to 180s of speech in one call.
   If that exceeds the window, the choices are a shorter ceiling or splitting
   the call — and splitting spends the one budget we cannot grow. **Measure a
   full-length request before the renderer depends on it**, together with
   whether inline style direction shifts delivery per beat (§4). One
   experiment answers both.

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
| SCRIPT | Gemini | a self-argument that stays coherent is the hardest generation here |
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
2. **Discourse format** — script beats with `move`, single-speaker TTS, Whisper alignment (words *and* beat boundaries), one-character composite.
3. **News + Pexels** — the two new footage drivers, stitching, cookies.
4. **PLAN stage** — shot list, keyword highlighting, transitions.
5. **Runner + cleanup** — launchd wake-start, auto-delete after render.

---

## 9. Open questions

Kept with their answers where they are closed, so the reasoning stays
legible.

- ~~**The left character is unverified.**~~ **Closed twice over.** It keys
  fine (`0xffffff:0.30:0.0`), and it is no longer used — the format has one
  host (§2).
- ~~**Whisper alignment costs a Groq call per turn.**~~ **Closed by being
  overtaken.** One audio file per video means one alignment call.
- **Does a 180s request fit in 10K TPM, and does inline style direction
  actually shift delivery per beat?** The two unmeasured things Gemini TTS is
  carrying, and one experiment answers both. The format's length ceiling and
  its expressiveness claim depend on the results. Measure before the renderer
  is built on either.
- **Does a single voice sustain three minutes?** The two-host version leaned
  on alternating voices for variety; this one leans entirely on the `move`
  structure and on footage cuts. If a three-minute self-argument drags in
  review, the lever is a shorter ceiling, not a second host — the budget
  decision that cut the second host stands.
- **Gemini TTS is a throughput cap, not a quality choice.** 10 requests/day
  means one 6-video run per day with 4 retries spare. If that is too tight,
  the question is whether Gemini earns its place at all — Edge TTS is free,
  unmetered, and the only path that still emits word timings natively.
