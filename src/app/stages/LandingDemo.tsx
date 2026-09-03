/**
 * The scroll demo below the landing hero.
 *
 * A reader who is not signed in cannot see the console, so this is the only
 * place the product can show what it actually does. It shows the real
 * pipeline: the seven stages RENDER runs, in order, with the same names the
 * console and the logs use — and it ends on a video this pipeline genuinely
 * produced, playable, rather than a mock.
 *
 * The glass carries it. Each stage lands one more fragment, so by the last
 * stage the fragments have assembled into a 9:16 pane with the finished
 * video inside — which is the product's own metaphor ("shatter into
 * reality") run backwards, and the reason this is shards rather than a
 * progress bar.
 *
 * Motion lives in `useScrollAssembly`; that file explains why it is
 * hand-written rather than GSAP/Lenis/three.js.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { preloadAtlas, type SetKey } from "../glass/geometry.ts";
import { Shard } from "../glass/Shard.tsx";
import { useScrollAssembly } from "../glass/useScrollAssembly.ts";

/** Where the finished demo render is served from. Produced by the pipeline, not authored. */
const DEMO_VIDEO = "/demo/demo-short.mp4";
const DEMO_POSTER = "/demo/demo-short.jpg";

/**
 * The seven stages, verbatim from `scripts/pipeline/render.ts`.
 *
 * Deliberately the real ones with the real names. A landing page that
 * invents friendlier stage names teaches the operator a vocabulary the logs
 * do not use, and this is the same person who will read those logs when it
 * breaks.
 */
interface DemoStage {
  id: string;
  label: string;
  line: string;
  /** Which atlas fragment lands on this stage, and where it settles in the pane. */
  piece: string;
  x: number;
  y: number;
  w: number;
  h: number;
  ring: number;
}

const STAGES: DemoStage[] = [
  { id: "watch", label: "WATCH", line: "Reddit, X, news RSS and YouTube, scored for the arguments people are actually having.", piece: "desktop-02b", x: -14, y: -6, w: 76, h: 40, ring: 2 },
  { id: "research", label: "RESEARCH", line: "A brief, built by tool-calling over what was ingested. Every claim cites a signal or it is dropped.", piece: "desktop-01a", x: 58, y: -8, w: 56, h: 62, ring: 2 },
  { id: "script", label: "SCRIPT", line: "One host, written in beats to a rolled performance — the format, the tone, the laughs.", piece: "desktop-04b", x: 6, y: 16, w: 82, h: 34, ring: 1 },
  { id: "plan", label: "PLAN", line: "Each beat becomes a filmable shot: what the audience sees while she argues.", piece: "desktop-03a", x: -16, y: 34, w: 66, h: 52, ring: 1 },
  { id: "source", label: "SOURCE", line: "Stock and real footage, motion-scored to the window worth showing. Provenance on every clip.", piece: "desktop-07a", x: 62, y: 40, w: 50, h: 58, ring: 1 },
  { id: "edit", label: "EDIT", line: "Each clip trimmed to its key moment and graded, over MCP.", piece: "desktop-06a", x: 2, y: 68, w: 78, h: 40, ring: 0 },
  { id: "render", label: "RENDER", line: "Narrated, captioned word by word, the host composited on top. A finished Short.", piece: "desktop-05b", x: 14, y: 30, w: 76, h: 44, ring: 0 },
];

/** Where in the timeline each stage's caption is the live one. */
const stageAt = (p: number): number => Math.min(STAGES.length - 1, Math.floor(p * STAGES.length * 1.08));

interface LandingDemoProps {
  setKey: SetKey;
}

export function LandingDemo({ setKey }: LandingDemoProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [progress, setProgress] = useState(0);
  const [ready, setReady] = useState(false);
  const [videoMissing, setVideoMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void preloadAtlas(setKey).then(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [setKey]);

  const onProgress = useCallback((p: number) => setProgress(p), []);
  useScrollAssembly(trackRef, stageRef, ready ? STAGES.length : 0, { onProgress });

  const active = stageAt(progress);
  // The payoff. The pane is assembled by the time the last fragment has
  // landed, and the video takes over the middle from there.
  const revealed = progress > 0.86;
  const shards = useMemo(() => STAGES, []);

  return (
    <section ref={trackRef} className="relative z-10 h-[560vh]" aria-label="How Mythos Engine builds a video">
      <div ref={stageRef} className="sticky top-0 flex h-dvh flex-col items-center justify-center gap-5 overflow-hidden px-6 py-8">
        {/* The assembling pane. `perspective` on the parent is what makes the
            fragments arrive from depth rather than just scaling up. Sized
            from the viewport *height* — a 9:16 pane sized from the width
            would be taller than the screen on any phone. */}
        <div className="relative aspect-[9/16] h-[min(46vh,58vw)] shrink-0" style={{ perspective: "1200px", perspectiveOrigin: "50% 45%" }}>
          <div className="absolute inset-0" style={{ transformStyle: "preserve-3d" }}>
            {ready &&
              shards.map((stage, i) => (
                <div
                  key={stage.id}
                  data-assembly-shard
                  className="absolute inset-0"
                  style={{ willChange: "transform, opacity", opacity: 0 }}
                >
                  <Shard
                    pieceId={stage.piece}
                    setKey={setKey}
                    className={i <= active ? "shard--lit" : ""}
                    style={{ left: `${stage.x}%`, top: `${stage.y}%`, width: `${stage.w}%`, height: `${stage.h}%`, zIndex: 10 + (2 - stage.ring) }}
                  />
                </div>
              ))}
          </div>

          {/* The finished render, inside the assembled glass. Playable —
              controls, not autoplay: this is the thing the reader came to
              judge, and taking the decision away from them is worse than
              making them press one button. */}
          <div
            className={`absolute inset-[7%] overflow-hidden rounded-[1.4rem] transition-opacity duration-700 ${revealed ? "opacity-100" : "pointer-events-none opacity-0"}`}
            style={{ boxShadow: "var(--shadow-1)" }}
          >
            {videoMissing ? (
              <div className="flex h-full w-full items-center justify-center bg-ink/60 p-6 text-center font-mono text-[0.68rem] text-bone">
                The demo render is not deployed yet.
              </div>
            ) : (
              <video
                className="h-full w-full bg-black object-cover"
                src={DEMO_VIDEO}
                poster={DEMO_POSTER}
                controls
                playsInline
                preload="none"
                onError={() => setVideoMissing(true)}
              >
                <track kind="captions" />
              </video>
            )}
          </div>
        </div>

        {/* The running commentary. One line at a time — a wall of seven
            paragraphs is a spec sheet, and nobody reads a spec sheet while
            scrolling. */}
        {/* Above the glass, deliberately: the bottom fragments overhang the
            pane on purpose, and a caption reading through broken glass is a
            nice idea and an unreadable one. */}
        <div className="pointer-events-none relative z-30 flex w-full max-w-xl shrink-0 flex-col items-center text-center">
          <p className="font-mono text-[0.62rem] uppercase tracking-[0.28em] text-bone">
            {revealed ? "Ready for review" : `Stage ${active + 1} of ${STAGES.length}`}
          </p>
          <p key={active} className="resolve-in font-display text-2xl font-semibold tracking-tight text-mercury sm:text-3xl">
            {revealed ? "One Short, fully audited." : STAGES[active].label}
          </p>
          <p key={`${active}-line`} className="resolve-in mt-2 min-h-10 text-sm text-bone">
            {revealed ? "Script, critic verdict, footage provenance and the TTS settings actually used — every render ships with the receipts." : STAGES[active].line}
          </p>
        </div>

        {/* Progress along the pipeline, as the fragments that have landed. */}
        <div className="relative z-30 flex shrink-0 items-center gap-1.5" aria-hidden="true">
          {STAGES.map((stage, i) => (
            <span key={stage.id} className={`h-1 rounded-full transition-all duration-300 ${i <= active ? "w-7 bg-violet" : "w-3 bg-hairline"}`} />
          ))}
        </div>
      </div>
    </section>
  );
}
