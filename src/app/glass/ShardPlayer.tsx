/**
 * A 9:16 pane of glass with a finished video sealed inside it, opened in
 * three clicks.
 *
 * Operator direction 2026-09-03: the landing demo's three states are how a
 * finished video is presented anywhere on this site, so this is the one
 * implementation of them and both surfaces mount it.
 *
 *   sealed   one unbroken window — no seams, no fracture —
 *            3D and lit under the cursor                    click to crack it
 *   cracked  the fragments spring apart; hovering one
 *            reveals what is behind it                      click again to play
 *   open     the middle clears, the video plays itself,
 *            the rim fragments stay live under the cursor
 *
 * **`sealed` is one drawn slab, not fragments at rest.** They tessellate,
 * but tessellated glass still shows its edges, and a caption saying the
 * glass has healed over a pane you can count the cracks in is a caption
 * arguing with the screen. The mosaic cross-fades into `.glass-slab` and
 * back out when it breaks. The slab is drawn rather than cut — there is no
 * atlas piece for "whole", the sprite's entire value being its break — but
 * it borrows the light rather than inventing it (`shards.css`).
 *
 * **Nothing may cover the field.** Every hover here — the tilt, the
 * specular, and the reveal behind a fragment — is `useShardField` binding
 * `pointerenter`/`pointerleave` to each `[data-shard]`. Anything spanning
 * the pane above them costs all three at once and costs them silently, so
 * the assembly wrappers and the keyboard button are `pointer-events: none`
 * and `.shard` is the only live area. That is also what lets the video take
 * its own clicks in `open`, and what lets a caller's scroll assembly own
 * the outer wrapper's transform without owning its hit-testing.
 *
 * Two things are deliberately NOT here. There is no caption: what the three
 * states mean is the caller's copy, and the landing's seven-stage scroll
 * and stage 6's export queue say completely different things about the same
 * pane. And there is no fracture SVG: `ForgePane` draws that, because a
 * pane that is still being made is a different object from a pane that is
 * finished, whatever they share.
 */
import { useCallback, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { MOBILE, preloadAtlas } from "./geometry.ts";
import { Shard } from "./Shard.tsx";
import { useShardField, type Placement } from "./useShardField.ts";
import { useAtlasReady } from "../useAtlasReady.ts";

export type SlabState = "sealed" | "cracked" | "open";

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
 * So the middle clears out entirely and the rim stays: the glass retreats to
 * the edges and holds the video like a frame. Measured on each fragment's
 * own centre, as a fraction of the half-pane, so it is a property of where
 * the break actually put the piece rather than a hand-picked list of ids
 * that would silently stop being true if the cut ever changed.
 */
const RIM_THRESHOLD = 0.55;

/**
 * The healed slab's hover pose — the same numbers `useShardField` gives a
 * fragment, on purpose.
 *
 * The slab is not a shard and cannot go through the spring loop, so it needs
 * its own handler. What it must not have is its own *feel*: someone who has
 * just watched fragments tilt under the cursor should find the healed pane
 * answering identically. So the tilt is `rx = -ly * 14`, `ry = +lx * 17`,
 * `scale 1.035` — copied, not invented — and the highlight is `.shard--hot`
 * plus `.shard-spec`, the same class and the same CSS as every other piece
 * of glass on this site.
 */
const SLAB_TILT_X = 14;
const SLAB_TILT_Y = 17;
const SLAB_LIFT = 40;
const SLAB_SCALE = 1.035;

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export interface ShardPlayerProps {
  /** The video that plays when the glass opens. Never a download URL — see `streamExportUrl`. */
  src: string;
  poster?: string;
  /**
   * What is behind fragment `i`, revealed under the cursor once the glass is
   * broken. `null` leaves that fragment plain glass.
   */
  revealUrl?: (index: number) => string | null;
  /**
   * A reveal that fully arrived stays (operator direction, 2026-09-01 — the
   * review surface's rule). Off on the landing, where the pane is something
   * to play with rather than a set of stills to uncover and compare.
   */
  keepReveals?: boolean;
  /**
   * False while something outside is still bringing the pane in, which makes
   * the glass un-clickable and holds it in `sealed`. The landing's scroll
   * assembly is the one caller that needs it.
   */
  armed?: boolean;
  /**
   * The caller drives the outer per-fragment wrapper (the landing's scroll
   * assembly writes its transform and opacity every frame). When false those
   * wrappers are inert at full opacity, which is what every other caller
   * wants.
   */
  assembling?: boolean;
  /** How far a fragment lifts toward the cursor. Matches the pane's size — a small card wants less. */
  hoverLift?: number;
  /** Announced whenever the glass changes state, so the caller can caption it. */
  onStateChange?: (state: SlabState) => void;
  /** Shown in place of the video when its bytes cannot be fetched. */
  missingLabel?: string;
  className?: string;
}

/**
 * No `setKey`. Every other glass surface takes one because it fills the
 * viewport and has to match its aspect; this pane is always the portrait
 * cut, on every screen, because the thing inside it is a 9:16 Short.
 */
export function ShardPlayer({
  src,
  poster,
  revealUrl,
  keepReveals = false,
  armed = true,
  assembling = false,
  hoverLift = 40,
  onStateChange,
  missingLabel = "This video's bytes are no longer available.",
  className = "",
}: ShardPlayerProps) {
  const fieldRef = useRef<HTMLDivElement>(null);
  const slabRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const [slab, setSlab] = useState<SlabState>("sealed");
  const [slabHot, setSlabHot] = useState(false);
  const [videoMissing, setVideoMissing] = useState(false);
  /** Autoplay refused even muted. Reported, never swallowed — and the controls are still there to press. */
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  /** Fragments whose reveal fully arrived, and therefore stays. Per fragment, never per pane. */
  const [kept, setKept] = useState<ReadonlySet<string>>(() => new Set());

  const ready = useAtlasReady("mobile", preloadAtlas);

  // **The whole portrait cut, not a sparse subset.** `forgeLayout` picks
  // 37-48% coverage because a card under construction should read as a card
  // *made of shards*. A sealed slab cannot: fragments with holes between
  // them read as scattered glass however they are arranged. All sixteen
  // `MOBILE` pieces tessellate, so at rest they meet along their real
  // photographed edges and the pane is whole.
  const placements = useMemo<Placement[]>(
    () =>
      MOBILE.map((piece, i) => ({
        key: `player-${piece.id}`,
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

  // Live in every state including the sealed slab: a pane that only comes
  // alive once broken reads as an image until you break it. `entrance` is
  // the caller's business — the landing's entrance is its scroll.
  useShardField(fieldRef, placements, { ready, entrance: !assembling, hoverLift });

  const healed = armed && slab === "sealed";
  /** There is a next state, so the pane is a button. In `open` there is not, and the video underneath gets its clicks back. */
  const canAdvance = armed && slab !== "open";

  /**
   * Start the video the moment the glass opens, rather than handing over a
   * paused frame under copy that says it is ready.
   *
   * Called synchronously from the click that opened it, so the gesture is
   * still live and the first attempt may have sound — which is the point of
   * a narrated video. If a browser refuses anyway, muting is the documented
   * way back in and is tried immediately; only if *that* is refused does
   * anyone hear about it, and then they hear the truth.
   */
  const startPlayback = useCallback(async () => {
    const el = videoRef.current;
    if (el === null) return;
    // One video at a time on a page. Stage 6 is a grid of these and three
    // narrations over each other is not a review surface. Done through the
    // DOM rather than by lifting playback into every caller's state: the
    // rule is "a page plays one", and it is true of a page.
    for (const other of document.querySelectorAll<HTMLVideoElement>("video[data-shard-player]")) {
      if (other !== el) other.pause();
    }
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
      onStateChange?.("cracked");
      // Buffer while the glass is broken open, so the play on the next click
      // starts on frames rather than on a spinner. `preload` follows the
      // state below; this is what makes a media element that already ran its
      // resource selection with `none` act on the change.
      videoRef.current?.load();
      return;
    }
    if (slab === "cracked") {
      setSlab("open");
      onStateChange?.("open");
      void startPlayback();
    }
  }, [slab, startPlayback, onStateChange]);

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

  return (
    // **The pane is the click target; nothing else may be.** The click lives
    // on the container every child bubbles to — including the keyboard
    // button below when Enter activates it, which is why one press advances
    // exactly one state.
    <div
      className={`relative aspect-[9/16] ${canAdvance ? "cursor-pointer" : ""} ${className}`}
      style={{ perspective: "1100px", perspectiveOrigin: "50% 45%" }}
      onClick={canAdvance ? advance : undefined}
    >
      {/* The video sits behind the glass and is uncovered by it, rather than
          fading in on top: the fragments clearing to the edges IS the
          reveal, and something appearing over the glass would read as a
          second object rather than as what was inside it.

          `preload` follows the state: nothing at all until the glass breaks,
          then the whole file. A grid of these must not fetch forty megabytes
          per card from someone who only scrolled past. */}
      <div
        className={`absolute inset-[6%] z-0 overflow-hidden rounded-[1.2rem] transition-opacity duration-700 ${slab === "open" ? "opacity-100" : "pointer-events-none opacity-0"}`}
        style={{ boxShadow: "var(--shadow-1)" }}
      >
        {videoMissing ? (
          <div className="flex h-full w-full items-center justify-center bg-ink/60 p-6 text-center font-mono text-[0.68rem] text-bone">{missingLabel}</div>
        ) : (
          <video
            ref={videoRef}
            data-shard-player
            className="h-full w-full bg-black object-cover"
            src={src}
            poster={poster}
            controls
            playsInline
            preload={slab === "sealed" ? "none" : "auto"}
            onError={() => setVideoMissing(true)}
          >
            <track kind="captions" />
          </video>
        )}
      </div>

      {/* **Pointer-transparent, except where there is actually glass.** Each
          fragment carries two wrappers that are `inset-0`, because the
          caller's assembly and the slab state each own a transform and
          neither may fight the other for one. A transparent div is still a
          hit target over its whole box, though, so sixteen of them stacked
          over the pane would swallow every pointer event before it reached a
          `.shard`. They opt out; `.shard` already carries
          `pointer-events: auto`, so the live area is the fragment's own box
          and the gaps between fragments belong to whatever is behind them. */}
      <div
        ref={fieldRef}
        className="pointer-events-none absolute inset-0 z-20 transition-opacity duration-700"
        style={{ transformStyle: "preserve-3d", opacity: healed ? 0 : 1, transitionTimingFunction: "var(--ease-out)" }}
      >
        {ready &&
          placements.map((p, i) => {
            // Outward from the pane's centre, so the break opens like a
            // break. Three nested transforms, each owned by exactly one
            // thing: the outer wrapper is the caller's assembly, the inner
            // one is the slab state (a CSS transition), and the `.shard`
            // itself is the cursor pose (the spring loop in useShardField).
            // They compose; none of them fights another for the same style.
            const dirX = (p.x + p.w / 2 - 50) / 50;
            const dirY = (p.y + p.h / 2 - 50) / 50;
            const { push, lift } = SPREAD[slab];
            const onRim = Math.max(Math.abs(dirX), Math.abs(dirY)) >= RIM_THRESHOLD;
            // Cleared out of the way of the video, not merely faded: an
            // invisible fragment still swallows the click meant for the
            // controls underneath it. Same reason the whole mosaic goes
            // inert while the slab is healed — it is at opacity 0 and the
            // unbroken window is the object.
            const cleared = slab === "open" && !onRim;
            const inert = cleared || healed;
            const reveal = revealUrl?.(i) ?? null;
            return (
              <div
                key={p.key}
                data-assembly-shard
                className="pointer-events-none absolute inset-0"
                style={{ willChange: "transform, opacity", opacity: assembling ? 0 : 1 }}
              >
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
                    className={armed ? "shard--lit" : ""}
                    style={{ left: `${p.x}%`, top: `${p.y}%`, width: `${p.w}%`, height: `${p.h}%`, zIndex: p.z, pointerEvents: inert ? "none" : "auto" }}
                  >
                    {/* What is behind this fragment, revealed under the
                        cursor by `.shard--hot` — the same reveal the review
                        cards have always used, same class, same CSS. Only
                        once the glass is broken: a slab you can see through
                        is not a slab. */}
                    {slab !== "sealed" && reveal !== null && (
                      <img
                        src={reveal}
                        alt=""
                        className={`forge-dream ${keepReveals && kept.has(p.key) ? "forge-dream--kept" : ""}`}
                        loading="lazy"
                        decoding="async"
                        // The latch. `transitionend` fires for the fade OUT
                        // too, and at that moment the fragment is at zero and
                        // nothing should be kept — so the test is not "a
                        // transition finished" but "a transition finished
                        // while this fragment was still under the cursor",
                        // which only a completed reveal satisfies.
                        onTransitionEnd={
                          keepReveals
                            ? (e) => {
                                if (e.propertyName !== "opacity") return;
                                const shard = e.currentTarget.closest("[data-shard]");
                                if (shard === null || !shard.classList.contains("shard--hot")) return;
                                setKept((prev) => (prev.has(p.key) ? prev : new Set(prev).add(p.key)));
                              }
                            : undefined
                        }
                        // A still that will not load is hidden rather than
                        // left as the browser's broken-image glyph inside the
                        // glass. Presentation, not a swallowed error: the
                        // fragment falls back to plain glass, which is
                        // exactly what a fragment with no reveal looks like.
                        onError={(e) => {
                          e.currentTarget.hidden = true;
                        }}
                      />
                    )}
                  </Shard>
                </div>
              </div>
            );
          })}
      </div>

      {/* **The healed slab.** Drawn rather than cut — see `.glass-slab` in
          shards.css. Decorative to a screen reader: the caller's copy says
          what it is and the button below is what operates it. */}
      <div
        ref={slabRef}
        aria-hidden="true"
        className={`glass-slab ${slabHot ? "shard--hot" : ""}`}
        style={{ opacity: healed ? 1 : 0, pointerEvents: healed ? "auto" : "none", zIndex: 30 }}
        onPointerEnter={() => setSlabHot(true)}
        onPointerMove={onSlabMove}
        onPointerLeave={onSlabLeave}
      >
        <div className="shard-layer shard-sheen" />
        <div className="shard-layer shard-spec" />
      </div>

      {/* Keyboard only. It carries the label and the focus ring and nothing
          else: `pointer-events: none` is what keeps it from becoming a lid
          over the field, and a button is still focusable and still activates
          on Enter without being a pointer target. Its click bubbles to the
          container above, which is the one place `advance` is wired. */}
      {canAdvance && (
        <button
          type="button"
          aria-label={slab === "sealed" ? "Crack the glass open" : "Play the video"}
          className="pointer-events-none absolute inset-0 z-40 rounded-[1.4rem] outline-none focus-visible:ring-2 focus-visible:ring-violet"
        >
          <span className="sr-only">{slab === "sealed" ? "Crack the glass open" : "Play the video"}</span>
          {slab === "cracked" && (
            <span className="absolute left-1/2 top-1/2 flex h-14 w-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-hairline bg-ink/70 backdrop-blur-sm">
              <span className="ml-1 block h-0 w-0 border-y-[9px] border-l-[14px] border-y-transparent border-l-mercury" />
            </span>
          )}
        </button>
      )}

      {/* Never swallowed. The video keeps its controls either way, so this
          is a nudge toward a button that is already there. */}
      {autoplayBlocked && slab === "open" && (
        <p className="pointer-events-none absolute -bottom-6 left-0 right-0 text-center font-mono text-[0.6rem] text-bone">
          Your browser blocked autoplay — press play.
        </p>
      )}
    </div>
  );
}
