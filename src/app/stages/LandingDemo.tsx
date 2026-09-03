/**
 * The scroll demo below the landing hero.
 *
 * A reader who is not signed in cannot see the console, so this is the only
 * place the product can show what it does. It shows the real pipeline — the
 * seven stages `scripts/pipeline/render.ts` runs, under the names the logs
 * and the console use — and it ends on a video this pipeline genuinely
 * produced, not a mock.
 *
 * **Scrolling builds; clicking opens.** The scroll assembles eight fragments
 * into an intact pane, one per stage, until the glass is whole: a slab, with
 * a video sealed inside it. From there it is the reader's move (operator
 * sketch, 2026-09-03):
 *
 *   sealed   one unbroken window — no seams, no
 *            fracture — 3D and cursor-lit.          click to crack it
 *   cracked  the fragments spring apart; hovering
 *            one reveals the frame behind it.       click again to play
 *   open     the glass clears to the edges and the
 *            video plays itself in the middle, the
 *            corner fragments still live under the
 *            cursor.
 *
 * **`sealed` is one drawn slab, not sixteen fragments at rest** (operator
 * direction, 2026-09-03). Tessellated shards still show their edges, and
 * "the glass has healed" under a pane you can count the cracks in is a
 * caption arguing with what is on screen. So the mosaic cross-fades into
 * `.demo-slab` when the scroll finishes, and back out when it breaks.
 *
 * **Nothing may cover the field.** Every hover on this page — the tilt,
 * the specular, and the frame revealed behind a fragment — is
 * `useShardField` binding `pointerenter` to each `[data-shard]`. Anything
 * spanning the pane above them costs all three at once, silently, and this
 * demo had two such things: the click target, and each fragment's own
 * `inset-0` transform wrappers, which are invisible but are still hit
 * targets over their whole box. Both are pointer-transparent now and
 * `.shard` is the only live area, which is also how the finished video got
 * its clicks back.
 *
 * The fragments, the tessellation and the hover reveal are the *same* card
 * the review section uses (`ForgePane`, `forge-layouts.ts`) — deliberately,
 * because a reader who signs in should recognise the object they were just
 * playing with. What differs is only what is revealed: the console shows the
 * Pexels stills a render is sourcing, and this shows frames of the finished
 * video, because they are what this page actually has and inventing stock
 * imagery for a landing page would be the one thing this surface must not do.
 *
 * Motion lives in `useScrollAssembly` (scroll) and `useShardField` (3D
 * hover); the first explains why it is hand-written rather than GSAP.
 */
import { useCallback, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { MOBILE, preloadAtlas } from "../glass/geometry.ts";
import { Shard } from "../glass/Shard.tsx";
import { useShardField, type Placement } from "../glass/useShardField.ts";
import { useScrollAssembly } from "../glass/useScrollAssembly.ts";
import { useAtlasReady } from "../useAtlasReady.ts";

/** Produced by `scripts/make-demo-asset.mjs` from a real export. */
const DEMO_VIDEO = "/demo/demo-short.mp4";
const DEMO_POSTER = "/demo/demo-short.jpg";
/** Eight frames across sixteen fragments: adjacent shards show neighbouring moments, which reads as one video behind the glass rather than sixteen unrelated ones. */
const DEMO_FRAMES = 8;
const frameUrl = (i: number): string => `/demo/frame-${(i % DEMO_FRAMES) + 1}.jpg`;

/**
 * The seven stages, verbatim from `scripts/pipeline/render.ts`.
 *
 * Deliberately the real ones with the real names. A landing page that
 * invents friendlier stage names teaches a vocabulary the logs do not use,
 * and this is the same person who will read those logs when it breaks.
 */
const STAGES = [
  { id: "watch", label: "WATCH", line: "Reddit, X, news RSS and YouTube, scored for the arguments people are actually having." },
  { id: "research", label: "RESEARCH", line: "A brief, built by tool-calling over what was ingested. Every claim cites a signal or it is dropped." },
  { id: "script", label: "SCRIPT", line: "One host, written in beats to a rolled performance — the format, the tone, the laughs." },
  { id: "plan", label: "PLAN", line: "Each beat becomes a filmable shot: what the audience sees while she argues." },
  { id: "source", label: "SOURCE", line: "Stock and real footage, motion-scored to the window worth showing. Provenance on every clip." },
  { id: "edit", label: "EDIT", line: "Each clip trimmed to its key moment and graded, over MCP." },
  { id: "render", label: "RENDER", line: "Narrated, captioned word by word, the host composited on top. A finished Short." },
];

/** Where the fragments have finished landing and the slab is whole. Matches `useScrollAssembly`'s default. */
const ASSEMBLY_END = 0.82;

type SlabState = "sealed" | "cracked" | "open";

/**
 * How far a fragment is pushed from the centre of the pane in each state,
 * and how much it lifts toward the reader.
 *
 * `sealed` is exactly zero on both, which is what makes it a slab: the
 * fragments sit at the positions they were photographed in, meeting along
 * their real edges. Every other state is that same tessellation pushed
 * outward, so the break always reads as *this* pane coming apart rather than
 * as loose glass arranged into a shape.
 */
const SPREAD: Record<SlabState, { push: number; lift: number }> = {
  sealed: { push: 0, lift: 0 },
  cracked: { push: 13, lift: 26 },
  open: { push: 16, lift: 44 },
};

/**
 * How near the rim a fragment has to sit to survive the `open` state.
 *
 * The first attempt pushed every fragment outward by a proportion of its
 * own distance from the centre, which moves the rim pieces a long way and
 * the middle ones almost not at all — so the finished video played *under*
 * four shards sitting squarely across it. The centre of a video is the part
 * you are least allowed to decorate.
 *
 * So the middle clears out entirely and the rim stays, which is what the
 * sketch asks for: the glass retreats to the edges and holds the video like
 * a frame. Measured on each fragment's own centre, as a fraction of the
 * half-pane, so it is a property of where the break actually put the piece
 * rather than a hand-picked list of ids that would silently stop being true
 * if the cut ever changed.
 */
const RIM_THRESHOLD = 0.55;

/**
 * The healed slab's hover pose — the same numbers `useShardField` gives a
 * fragment, on purpose.
 *
 * The slab is not a shard (there is no atlas piece for "unbroken", and the
 * sprite's whole value is its break), so it cannot go through the spring
 * loop and needs its own handler. What it must not have is its own *feel*:
 * a reader who has spent five screens watching fragments tilt under the
 * cursor should find the healed pane answering identically. So the tilt is
 * `rx = -ly * 14`, `ry = +lx * 17`, `scale 1.035` — copied, not invented —
 * and the highlight is `.shard--hot` + `.shard-spec`, the same class and
 * the same CSS every other piece of glass on this site uses.
 */
const SLAB_TILT_X = 14;
const SLAB_TILT_Y = 17;
const SLAB_LIFT = 40;
const SLAB_SCALE = 1.035;

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * No `setKey`. Every other glass surface takes one because it fills the
 * viewport and has to match its aspect; this pane is always the portrait
 * cut, on every screen, because the thing inside it is a 9:16 Short.
 */
export function LandingDemo() {
  const trackRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const [progress, setProgress] = useState(0);
  const [slab, setSlab] = useState<SlabState>("sealed");
  const [videoMissing, setVideoMissing] = useState(false);
  const [slabHot, setSlabHot] = useState(false);
  /** Autoplay refused even muted. Surfaced in the caption rather than swallowed — the video keeps its controls, so the reader can still start it. */
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const slabRef = useRef<HTMLDivElement>(null);

  // **The whole portrait cut, not the review section's eight.**
  // `forgeLayout` picks a deliberately sparse subset — 37-48% coverage —
  // because a review card is meant to read as a *card made of shards*. The
  // sealed state here has to read as an unbroken slab, and eight fragments
  // with holes between them read as scattered glass no matter how they are
  // arranged. All sixteen tessellate the pane, so at rest they meet along
  // their real photographed edges and the slab is whole.
  const ready = useAtlasReady("mobile", preloadAtlas);

  const placements = useMemo<Placement[]>(
    () =>
      MOBILE.map((piece, i) => ({
        key: `demo-${piece.id}`,
        pieceId: piece.id,
        setKey: "mobile" as const,
        x: piece.x,
        y: piece.y,
        w: piece.w,
        h: piece.h,
        cx: piece.cx,
        cy: piece.cy,
        ring: piece.ring,
        z: 10 + i,
      })),
    [],
  );

  // The 3D hover, on every state including the sealed slab — the operator
  // asked for the slab itself to be live under the cursor, and a pane that
  // only comes alive once broken reads as an image until you break it.
  // `entrance: false` because the scroll is the entrance.
  useShardField(fieldRef, placements, { ready, entrance: false, hoverLift: 40 });

  const onProgress = useCallback((p: number) => setProgress(p), []);
  useScrollAssembly(trackRef, stageRef, ready ? placements.length : 0, { assemblyEnd: ASSEMBLY_END, onProgress });

  const assembled = progress >= ASSEMBLY_END;
  const active = Math.min(STAGES.length - 1, Math.floor((progress / ASSEMBLY_END) * STAGES.length));

  /**
   * The scroll is finished and the reader has not broken the glass yet — so
   * the pane is one unbroken window (operator direction, 2026-09-03). The
   * mosaic fades out and `.demo-slab` fades in; the fragments are still
   * mounted, still in their landed positions, and come straight back when
   * it cracks.
   */
  const healed = assembled && slab === "sealed";
  /** There is a next state, so the pane is a button. In `open` there is not, and the video underneath gets its clicks back. */
  const canAdvance = assembled && slab !== "open";

  /**
   * Start the Short the moment the glass opens (operator direction,
   * 2026-09-03) rather than handing the reader a paused video under a
   * caption announcing it is ready.
   *
   * Called synchronously from the click that opened it, so the gesture is
   * still live and the first attempt may have sound — which is the point,
   * this is a narrated video. If a browser refuses anyway, muting is the
   * documented way back in and is tried immediately. Only if *that* is
   * refused does the reader see anything about it, and then they see the
   * truth in the caption with the controls still there to press.
   */
  const startPlayback = useCallback(async () => {
    const el = videoRef.current;
    if (el === null) return;
    try {
      await el.play();
    } catch {
      el.muted = true;
      try {
        await el.play();
      } catch {
        setAutoplayBlocked(true);
      }
    }
  }, []);

  const advance = useCallback(() => {
    if (slab === "sealed") {
      setSlab("cracked");
      // Buffer while the reader is looking at the break, so the play on the
      // next click starts on frames rather than on a spinner. `preload`
      // follows the state below; this is what makes a media element that
      // already ran its resource selection with `none` act on the change.
      videoRef.current?.load();
      return;
    }
    if (slab === "cracked") {
      setSlab("open");
      void startPlayback();
    }
  }, [slab, startPlayback]);

  /**
   * The healed slab's own cursor pose. Three lines of the spring loop's
   * hover branch, without the spring: one element, one transform, and the
   * CSS transition does the smoothing that `useShardField` gets from `k`.
   */
  const onSlabMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const el = slabRef.current;
    if (el === null) return;
    const r = el.getBoundingClientRect();
    const lx = (event.clientX - r.left) / r.width - 0.5;
    const ly = (event.clientY - r.top) / r.height - 0.5;
    // Drives .shard-spec's radial centre — the same two variables the
    // fragments use, so the highlight is literally the same highlight.
    el.style.setProperty("--mx", `${((lx + 0.5) * 100).toFixed(1)}%`);
    el.style.setProperty("--my", `${((ly + 0.5) * 100).toFixed(1)}%`);
    if (prefersReducedMotion()) return;
    el.style.transform = `translate3d(0px, 0px, ${SLAB_LIFT}px) rotateX(${(-ly * SLAB_TILT_X).toFixed(2)}deg) rotateY(${(lx * SLAB_TILT_Y).toFixed(2)}deg) scale(${SLAB_SCALE})`;
  }, []);

  const onSlabLeave = useCallback(() => {
    setSlabHot(false);
    const el = slabRef.current;
    if (el !== null) el.style.transform = "translate3d(0px, 0px, 0px) rotateX(0deg) rotateY(0deg) scale(1)";
  }, []);

  const caption =
    slab === "open"
      ? {
          eyebrow: "Ready for review",
          title: "One Short, fully audited.",
          line: autoplayBlocked
            ? "Your browser blocked autoplay — press play. Script, critic verdict, footage provenance and the TTS settings actually used ship with every render."
            : "Script, critic verdict, footage provenance and the TTS settings actually used — every render ships with the receipts.",
        }
      : slab === "cracked"
        ? { eyebrow: "Inside the glass", title: "Every fragment is a frame.", line: "Hover a shard to see through it. Click again to play the whole thing." }
        : assembled
          ? { eyebrow: "Ready", title: "The glass has healed.", line: "There is a finished Short sealed in there. Click the slab to crack it open." }
          : { eyebrow: `Stage ${active + 1} of ${STAGES.length}`, title: STAGES[active].label, line: STAGES[active].line };

  return (
    <section ref={trackRef} className="relative z-10 h-[560vh]" aria-label="How Mythos Engine builds a video">
      <div ref={stageRef} className="sticky top-0 flex h-dvh flex-col items-center justify-center gap-5 overflow-hidden px-6 py-8">
        {/* **The pane is the click target; nothing else may be.**
            The three states used to be advanced by a `<button>` stretched
            over the whole pane at z-40. It worked, and it was the reason
            none of the hover ever fired: `useShardField` binds
            `pointerenter`/`pointerleave` to each `[data-shard]`, and a lid
            over the field means the cursor never reaches one. So no tilt,
            no specular, and — in `cracked` — no `.shard--hot`, which is the
            only thing that reveals the frame behind a fragment. The lid is
            gone; the click lives here, on the container every child bubbles
            to, including the button below when a keyboard activates it. */}
        <div
          className={`relative aspect-[9/16] h-[min(46vh,58vw)] shrink-0 ${canAdvance ? "cursor-pointer" : ""}`}
          style={{ perspective: "1100px", perspectiveOrigin: "50% 45%" }}
          onClick={canAdvance ? advance : undefined}
        >
          {/* The video sits behind the glass and is uncovered by it, rather
              than fading in on top: the fragments clearing to the edges IS
              the reveal, and something appearing over the glass would read
              as a second object rather than as what was inside it.

              `preload` follows the state: nothing at all until the reader
              breaks the glass, then the whole file, so the play on the next
              click starts on frames. A landing page has no business
              fetching 40 MB from a reader who only scrolled past. */}
          <div className={`absolute inset-[6%] z-0 overflow-hidden rounded-[1.2rem] transition-opacity duration-700 ${slab === "open" ? "opacity-100" : "pointer-events-none opacity-0"}`} style={{ boxShadow: "var(--shadow-1)" }}>
            {videoMissing ? (
              <div className="flex h-full w-full items-center justify-center bg-ink/60 p-6 text-center font-mono text-[0.68rem] text-bone">The demo render is not deployed yet.</div>
            ) : (
              <video
                ref={videoRef}
                className="h-full w-full bg-black object-cover"
                src={DEMO_VIDEO}
                poster={DEMO_POSTER}
                controls
                playsInline
                preload={slab === "sealed" ? "none" : "auto"}
                onError={() => setVideoMissing(true)}
              >
                <track kind="captions" />
              </video>
            )}
          </div>

          {/* **Pointer-transparent, except where there is actually glass.**
              Each fragment carries two wrappers that are `inset-0`, because
              the scroll assembly and the slab state each own a transform and
              neither may fight the other for one. A transparent div is still
              a hit target over its whole box, though, so sixteen of them
              stacked over the pane swallowed every pointer event before it
              could reach a `.shard` — the second half of why hover was dead,
              and the whole of why the finished video could not be clicked in
              `open`. The wrappers opt out; `.shard` already carries
              `pointer-events: auto`, so the live area is the fragment's own
              box and the gaps between fragments belong to whatever is
              behind them. */}
          <div
            ref={fieldRef}
            className="pointer-events-none absolute inset-0 z-20 transition-opacity duration-700"
            style={{ transformStyle: "preserve-3d", opacity: healed ? 0 : 1, transitionTimingFunction: "var(--ease-out)" }}
          >
            {ready &&
              placements.map((p, i) => {
                // Outward from the pane's centre, so the break opens like a
                // break. Three nested transforms, each owned by exactly one
                // thing: this wrapper is the scroll assembly (written every
                // frame by useScrollAssembly), the inner one is the slab
                // state (a CSS transition), and the `.shard` itself is the
                // cursor pose (the spring loop in useShardField). They
                // compose; none of them fights another for the same style.
                const dirX = (p.x + p.w / 2 - 50) / 50;
                const dirY = (p.y + p.h / 2 - 50) / 50;
                const { push, lift } = SPREAD[slab];
                const onRim = Math.max(Math.abs(dirX), Math.abs(dirY)) >= RIM_THRESHOLD;
                // Cleared out of the way of the video, not merely faded:
                // an invisible fragment still swallows the click that was
                // meant for the play button underneath it. Same reason the
                // whole mosaic goes inert while the slab is healed — it is
                // at opacity 0 and the unbroken window is the object.
                const cleared = slab === "open" && !onRim;
                const inert = cleared || healed;
                return (
                  <div key={p.key} data-assembly-shard className="pointer-events-none absolute inset-0" style={{ willChange: "transform, opacity", opacity: 0 }}>
                    <div
                      className="pointer-events-none absolute inset-0 transition-[transform,opacity] duration-[900ms]"
                      style={{
                        transform: `translate3d(${(dirX * push).toFixed(2)}%, ${(dirY * push).toFixed(2)}%, ${lift}px)`,
                        transitionTimingFunction: "var(--ease-out)",
                        opacity: cleared ? 0 : 1,
                      }}
                    >
                      <Shard
                        pieceId={p.pieceId}
                        setKey={p.setKey}
                        className={assembled ? "shard--lit" : ""}
                        style={{ left: `${p.x}%`, top: `${p.y}%`, width: `${p.w}%`, height: `${p.h}%`, zIndex: p.z, pointerEvents: inert ? "none" : "auto" }}
                      >
                        {/* What is behind this fragment: a real frame of the
                            real video, revealed under the cursor by
                            `.shard--hot` — the same reveal the review
                            section's cards use, same class, same CSS. Only
                            once the glass is broken: a slab you can see
                            through is not a slab. */}
                        {slab !== "sealed" && <img src={frameUrl(i)} alt="" className="forge-dream" loading="lazy" decoding="async" onError={(e) => { e.currentTarget.hidden = true; }} />}
                      </Shard>
                    </div>
                  </div>
                );
              })}
          </div>

          {/* **The healed slab** (operator direction, 2026-09-03): when the
              scroll finishes assembling the pane, the mosaic fades into one
              unbroken window of glass — no seams, no fracture — and that
              window is live under the cursor exactly like every fragment is.
              It is drawn rather than cut, because there is no atlas piece
              for "whole"; see `.demo-slab` in shards.css. Decorative to a
              screen reader: the caption says what it is and the button below
              is what operates it. */}
          <div
            ref={slabRef}
            aria-hidden="true"
            className={`demo-slab ${slabHot ? "shard--hot" : ""}`}
            style={{ opacity: healed ? 1 : 0, pointerEvents: healed ? "auto" : "none", zIndex: 30 }}
            onPointerEnter={() => setSlabHot(true)}
            onPointerMove={onSlabMove}
            onPointerLeave={onSlabLeave}
          >
            <div className="shard-layer shard-sheen" />
            <div className="shard-layer shard-spec" />
          </div>

          {/* Keyboard only. It carries the label and the focus ring and
              nothing else: `pointer-events: none` is what keeps it from
              becoming the lid again, and a button is still focusable and
              still activates on Enter without being a pointer target. Its
              click bubbles to the container above, which is the one place
              `advance` is wired. */}
          {canAdvance && (
            <button
              type="button"
              aria-label={slab === "sealed" ? "Crack the glass open" : "Play the finished Short"}
              className="pointer-events-none absolute inset-0 z-40 rounded-[1.4rem] outline-none focus-visible:ring-2 focus-visible:ring-violet"
            >
              <span className="sr-only">{slab === "sealed" ? "Crack the glass open" : "Play the finished Short"}</span>
              {slab === "cracked" && (
                <span className="absolute left-1/2 top-1/2 flex h-14 w-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-hairline bg-ink/70 backdrop-blur-sm">
                  <span className="ml-1 block h-0 w-0 border-y-[9px] border-l-[14px] border-y-transparent border-l-mercury" />
                </span>
              )}
            </button>
          )}
        </div>

        {/* Above the glass, deliberately: the fragments overhang the pane on
            purpose, and a caption read through broken glass is a nice idea
            and an unreadable one. */}
        <div className="pointer-events-none relative z-30 flex w-full max-w-xl shrink-0 flex-col items-center text-center">
          <p className="font-mono text-[0.62rem] uppercase tracking-[0.28em] text-bone">{caption.eyebrow}</p>
          <p key={caption.title} className="resolve-in font-display text-2xl font-semibold tracking-tight text-mercury sm:text-3xl">
            {caption.title}
          </p>
          <p key={caption.line} className="resolve-in mt-2 min-h-10 text-sm text-bone">
            {caption.line}
          </p>
        </div>

        <div className="relative z-30 flex shrink-0 items-center gap-1.5" aria-hidden="true">
          {STAGES.map((stage, i) => (
            <span key={stage.id} className={`h-1 rounded-full transition-all duration-300 ${assembled || i <= active ? "w-7 bg-violet" : "w-3 bg-hairline"}`} />
          ))}
        </div>
      </div>
    </section>
  );
}
