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
 * **The pane itself is `ShardPlayer`**, which is also what stage 6's
 * review cards are (operator direction, 2026-09-03): the three states, the
 * healed slab, the per-fragment reveal and the autoplay are one
 * implementation, and a reader who signs in meets the same object again.
 * What this file adds is the only thing that is the landing's alone — the
 * scroll. `useScrollAssembly` writes each fragment's outer wrapper as the
 * reader travels the track, and the pane stays un-clickable (`armed`)
 * until that finishes, because a slab that can be cracked on the first
 * screen makes the five below it pointless.
 *
 * What is revealed behind a fragment differs from stage 6's, deliberately:
 * the console reveals the Pexels stills a render is sourcing from an
 * authenticated endpoint, and this reveals frames of the finished video,
 * because that is what a signed-out page actually has. Inventing stock
 * imagery for this particular product's landing page is the one thing it
 * must not do.
 *
 * Motion lives in `useScrollAssembly` (scroll) and `useShardField` (3D
 * hover); the first explains why it is hand-written rather than GSAP.
 */
import { useCallback, useRef, useState } from "react";
import { preloadAtlas } from "../glass/geometry.ts";
import { ShardPlayer, type SlabState } from "../glass/ShardPlayer.tsx";
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

/** The whole portrait cut, so the assembly has one fragment to land per stage and two to spare. */
const FRAGMENT_COUNT = 16;

export function LandingDemo() {
  const trackRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  const [progress, setProgress] = useState(0);
  const [slab, setSlab] = useState<SlabState>("sealed");

  const onProgress = useCallback((p: number) => setProgress(p), []);
  /**
   * The same gate `ShardPlayer` uses, and it has to be here too.
   *
   * `useScrollAssembly` reads the fragments out of the DOM once, when its
   * effect installs, and gives up if there are none — so it must not
   * install before the atlas has decoded and the pane has rendered them.
   * Passing a constant count installed it on mount, found zero fragments,
   * and never ran again: the reader scrolled five screens against a caption
   * frozen on STAGE 1 OF 7. Both hooks resolve from `preloadAtlas`'s one
   * cached promise in the same microtask, so React commits them together
   * and this effect — a parent's, therefore after the child's — sees a
   * populated stage.
   */
  const fragmentsReady = useAtlasReady("mobile", preloadAtlas);
  useScrollAssembly(trackRef, stageRef, fragmentsReady ? FRAGMENT_COUNT : 0, { assemblyEnd: ASSEMBLY_END, onProgress });

  const assembled = progress >= ASSEMBLY_END;
  const active = Math.min(STAGES.length - 1, Math.floor((progress / ASSEMBLY_END) * STAGES.length));

  const caption =
    slab === "open"
      ? { eyebrow: "Ready for review", title: "One Short, fully audited.", line: "Script, critic verdict, footage provenance and the TTS settings actually used — every render ships with the receipts." }
      : slab === "cracked"
        ? { eyebrow: "Inside the glass", title: "Every fragment is a frame.", line: "Hover a shard to see through it. Click again to play the whole thing." }
        : assembled
          ? { eyebrow: "Ready", title: "The glass has healed.", line: "There is a finished Short sealed in there. Click the slab to crack it open." }
          : { eyebrow: `Stage ${active + 1} of ${STAGES.length}`, title: STAGES[active].label, line: STAGES[active].line };

  return (
    <section ref={trackRef} className="relative z-10 h-[560vh]" aria-label="How Mythos Engine builds a video">
      <div ref={stageRef} className="sticky top-0 flex h-dvh flex-col items-center justify-center gap-4 overflow-hidden px-6 py-6">
        {/* `assembling`: the scroll owns each fragment's outer wrapper and
            writes its transform and opacity every frame, which is why they
            start at zero here and nowhere else. `armed` is what holds the
            glass shut until the reader has actually watched it assemble —
            a pane that can be clicked open on the first screen makes the
            five below it pointless.

            **The pane reaches the top of the screen** (operator sketch,
            2026-09-03): it was landing a fifth of the way down, which left
            the finished Short — the one thing this whole scroll is
            travelling toward — smaller than the copy under it. The stack is
            centred, so height is the only lever: every vh added lifts the
            top by half of it, and 68vh puts it where the sketch drew the
            line. Still `min()`ed against the viewport's width, because the
            cut is 9:16 and a tall narrow screen would otherwise size the
            pane wider than the screen holding it.

            **A phone needs its own pair of numbers** (operator sketch on an
            iPhone, 2026-09-03). The width cap is what governs there — 74vw
            of a 402px screen is a 297px-tall pane, barely a third of the
            viewport — so the same line drawn across the top of the screen
            sat twice as far above the glass as it does on a laptop. Below
            `sm` the cap is lifted to 130vw (the pane is then at most 73vw
            wide, so it still cannot outgrow the screen) and height governs
            on a phone too. 64vh rather than 68 because the caption wraps to
            more lines on a narrow screen and the stack is centred: the
            copy's extra height would otherwise push the glass back down.
            `sm:` restores the laptop's exact pair, which is already right. */}
        <ShardPlayer
          className="h-[min(64vh,130vw)] shrink-0 sm:h-[min(68vh,74vw)]"
          src={DEMO_VIDEO}
          poster={DEMO_POSTER}
          revealUrl={frameUrl}
          armed={assembled}
          assembling
          onStateChange={setSlab}
          missingLabel="The demo render is not deployed yet."
        />

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
