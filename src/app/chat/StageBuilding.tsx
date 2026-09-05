import { useCallback, useEffect, useMemo, useState } from "react";
import { describeError, getBrief, getRunProgress, isUnauthorized, streamExportUrl } from "../api.ts";
import { ForgePane } from "../glass/ForgePane.tsx";
import type { SetKey } from "../glass/geometry.ts";
import { ShardPlayer } from "../glass/ShardPlayer.tsx";
import { MetadataPanel } from "../stages/MetadataPanel.tsx";
import type { BriefView, RunProgress } from "../types.ts";
import { parseDigest } from "../types.ts";
import { StageFrame } from "../ui/StageFrame.tsx";
import { ExportActions } from "./ExportActions.tsx";
import { OrbitField } from "./OrbitField.tsx";
import { dockedFraction } from "./orbit.ts";

/**
 * The chat route's second screen — panels 2 and 3 of the design board, on one
 * surface.
 *
 * The sequence, as drawn:
 *
 *   1. The orb rises and settles **dead centre of the video card**, which is
 *      also the centre of the ring and the point every shard docks into
 *      (operator direction, 2026-09-05: "make sure the orb is in the center
 *      as the video card gets slowly formed"). It replaces both the board's
 *      black hole and its aurora (operator direction, 2026-09-04): "instead
 *      of using the aurora use the gradient orb and make it smoothly and
 *      fluid-like to emerge from the text input place and drift upwards
 *      gently".
 *
 *      **The orb is rendered by `OrbitField`, not here.** It has to be a
 *      sibling of the shards to be something they can pass behind and in
 *      front of; while it lived in this column no z-index on any shard could
 *      reach it. This screen owns *when* it rises and when it goes, and marks
 *      the element it centres on — nothing else.
 *   2. The input locks — "won't accept anything until run ends (success or
 *      fails)". The prompt stays visible above it, greyed, so the operator can
 *      see what they asked for.
 *   3. The orb gathers the page's edge glass and sets it orbiting, small,
 *      tumbling on three axes, trailing dust, half of it behind the orb and
 *      half in front (`OrbitField`).
 *   4. **As each pipeline stage lands**, shards leave the orbit and dock into
 *      the video card, whose fracture heals from 1 to 0.
 *   5. Healed, the card becomes a `ShardPlayer` — the same sealed → cracked →
 *      open → autoplay progression the landing demo and stage 6 use. The orb
 *      is still visible behind the sealed slab, and disappears on the first
 *      crack, exactly as the board says.
 *   6. Download · Review · Metadata · Discard underneath.
 *
 * **Progress is counted, never estimated.** Six observed facts, each one a row
 * something wrote after doing the thing: the brief was digested, the brief
 * knows its signal, a script exists, a render row exists, the render finished,
 * an export exists. That rule is stated in three other places in this codebase
 * (`Stage5Forge`, `ForgePane`, `src/server/console/runs.ts`) and it holds here
 * for the same reason — an ETA that slid backwards would be the one thing on
 * this screen that was not true.
 */

const POLL_MS = 5_000;

interface StageBuildingProps {
  briefId: string;
  /** Null when the brief was recorded but no run was triggered — then there is nothing to poll, and this screen says so. */
  traceId: string | null;
  prompt: string;
  dispatchNote: string | null;
  setKey: SetKey;
  onReview: () => void;
  onUnauthorized: () => void;
}

/**
 * The six facts, in the order they become true.
 *
 * The first two are the chat route's own and have no equivalent on the
 * brainstorm route: DIGEST runs before SCRIPT, and the operator is watching it.
 * The last four are `Stage5Forge`'s `milestones`, unchanged.
 */
function milestonesOf(brief: BriefView | null, progress: RunProgress | null): boolean[] {
  const video = progress?.videos[0] ?? null;
  return [
    brief?.digestJson !== null && brief?.digestJson !== undefined,
    brief?.signalId !== null && brief?.signalId !== undefined,
    video !== null,
    video?.renderId != null,
    video?.renderStatus === "rendered",
    video?.exportId != null,
  ];
}

/** The line under the orb: what the run is doing, said as a fact rather than as a percentage. */
function statusLine(brief: BriefView | null, progress: RunProgress | null, done: number): string {
  if (brief?.status === "failed") return brief.failureReason ?? "This run failed.";
  if (progress?.status === "failed") return "The run failed. Stage 4 of the run view has the error.";
  if (progress?.status === "not_triggered") return "Recorded, but no run was started.";
  if (done === 0) return "Waiting for the runner to pick this up…";
  const digest = parseDigest(brief ?? ({} as BriefView));
  if (done <= 2 && digest !== null) {
    return digest.specificity === "topic_only"
      ? `Read as a bare topic — building the strongest ${digest.topic} story instead.`
      : `Researching “${digest.title}”…`;
  }
  if (done <= 3) return "Writing the script…";
  if (done <= 4) return "Sourcing footage, narrating, cutting…";
  if (done <= 5) return "Rendering…";
  return "Done.";
}

export function StageBuilding({ briefId, traceId, prompt, dispatchNote, setKey, onReview, onUnauthorized }: StageBuildingProps) {
  const [brief, setBrief] = useState<BriefView | null>(null);
  const [progress, setProgress] = useState<RunProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [risen, setRisen] = useState(false);
  const [cracked, setCracked] = useState(false);
  const [metadataOpen, setMetadataOpen] = useState(false);

  // The rise is a CSS transition between two classes rather than a WAAPI
  // animation, so it survives a re-render mid-flight — and this screen
  // re-renders every time the poll lands.
  useEffect(() => {
    const id = window.setTimeout(() => setRisen(true), 40);
    return () => window.clearTimeout(id);
  }, []);

  /**
   * One poll for both the brief and the run.
   *
   * The brief is polled as well as the run because DIGEST's conclusion lives
   * on the brief row, and it is the first thing that becomes true — the run
   * has no video to report until SCRIPT has written one, which on this route
   * is several minutes and two stages later. Polling only the run would leave
   * this screen blank through the part the operator is most curious about.
   *
   * A self-rescheduling `setTimeout`, not `setInterval`, and it stops on a
   * terminal state — the same shape `Stage5Forge` uses, for the same reason:
   * an interval keeps firing while a slow response is still in flight.
   */
  useEffect(() => {
    let cancelled = false;
    let timer = 0;

    const poll = async (): Promise<void> => {
      const briefResult = await getBrief(briefId);
      if (cancelled) return;
      if (briefResult.ok) {
        setBrief(briefResult.value);
      } else if (isUnauthorized(briefResult.error)) {
        onUnauthorized();
        return;
      } else {
        setError(describeError(briefResult.error));
      }

      let runStatus: string | null = null;
      if (traceId !== null) {
        const runResult = await getRunProgress(traceId);
        if (cancelled) return;
        if (runResult.ok) {
          setProgress(runResult.value);
          runStatus = runResult.value.status;
        } else if (isUnauthorized(runResult.error)) {
          onUnauthorized();
          return;
        }
      }

      const briefDone = briefResult.ok && (briefResult.value.status === "succeeded" || briefResult.value.status === "failed");
      const runDone = runStatus === "succeeded" || runStatus === "failed" || runStatus === "not_triggered";
      // Both have to be settled. The brief is closed by `chat-render.ts` after
      // the render returns, so a run that reports `succeeded` while the brief
      // is still `running` is the one-beat gap between those two writes —
      // stopping there would leave the transcript one line short.
      if (briefDone && (traceId === null || runDone)) return;
      timer = window.setTimeout(() => void poll(), POLL_MS);
    };

    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [briefId, traceId, onUnauthorized]);

  const milestones = useMemo(() => milestonesOf(brief, progress), [brief, progress]);
  const done = milestones.filter(Boolean).length;
  const fraction = dockedFraction(milestones);
  const video = progress?.videos[0] ?? null;
  const exportId = video?.exportId ?? null;
  const running = brief?.status !== "failed" && progress?.status !== "failed" && exportId === null;

  const onPlayerState = useCallback((state: "sealed" | "cracked" | "open") => {
    // The board: the orb is "still visible behind the glass slab, but upon
    // first crack it disappears". Latched rather than derived, so going back
    // to `sealed` does not bring it back — the moment has happened.
    if (state !== "sealed") setCracked(true);
  }, []);

  return (
    <>
      {/* Replaces EdgeFrame for the life of this screen — these ARE the edge
          shards, leaving their edges. App.tsx hides the frame here. */}
      <OrbitField setKey={setKey} progress={fraction} active={risen} cracked={cracked} anchor={`[data-orbit-anchor="${briefId}"]`} />

      <StageFrame
        eyebrow="Step 2 of 3"
        title={exportId === null ? "Shattering into reality" : "It's finished"}
        blurb={statusLine(brief, progress, done)}
      >
        <div className="pointer-events-auto mx-auto flex h-full w-full max-w-2xl flex-col items-center">
          {/* The locked input. Still on screen, still holding the prompt,
              accepting nothing — "won't accept anything until run ends". */}
          <div className="z-10 w-full shrink-0 rounded-full border border-hairline bg-slate/40 px-5 py-3 text-sm text-bone/70">
            <span className="line-clamp-1">{prompt}</span>
          </div>

          {dispatchNote !== null && <p className="z-10 mt-3 text-center font-mono text-[0.65rem] text-sodium">{dispatchNote}</p>}
          {error !== null && <p className="z-10 mt-3 text-center text-xs text-rose">{error}</p>}

          <div className="relative z-10 mt-8 flex min-h-0 w-full flex-1 flex-col items-center">
            {/* Before the export exists the card is cracked glass healing as
                the run advances; after it, it is the finished video in the
                same pane. `fracture` is `1 - done/6` — counted facts, not a
                curve. */}
            {exportId === null ? (
              /* The anchor: `OrbitField` measures this box every frame and
                 centres the orb, the ring and the dock target on it. Keyed by
                 brief id so the selector cannot match a stale node left by a
                 previous screen. */
              <div className="w-1/2 max-w-[16rem]" data-orbit-anchor={briefId}>
                <ForgePane fracture={1 - fraction} glow="var(--violet)" clips={[]} working={running} />
              </div>
            ) : (
              <>
                <div className="w-1/2 max-w-[16rem]" data-orbit-anchor={briefId}>
                  <ShardPlayer
                    src={streamExportUrl(exportId)}
                    onStateChange={onPlayerState}
                    keepReveals
                    hoverLift={46}
                    missingLabel="This export's bytes are gone — it may have expired."
                  />
                </div>
                <p className="mt-4 text-center font-mono text-[0.62rem] text-bone">Click the pane to crack it open, then again to play.</p>
                <div className="mt-4">
                  <ExportActions
                    exportId={exportId}
                    status={video?.exportStatus ?? "ready_for_review"}
                    metadataOpen={metadataOpen}
                    onToggleMetadata={() => setMetadataOpen((open) => !open)}
                    onChanged={onReview}
                    onUnauthorized={onUnauthorized}
                  />
                </div>
                {metadataOpen && (
                  <div className="mt-4 w-full overflow-y-auto">
                    <MetadataPanel exportId={exportId} onClose={() => setMetadataOpen(false)} onUnauthorized={onUnauthorized} />
                  </div>
                )}
              </>
            )}

            {/* The counted facts, said out loud. Six checkboxes rather than a
                bar, because that is what the number actually is. */}
            <ol className="mt-6 flex shrink-0 flex-wrap justify-center gap-x-4 gap-y-1 font-mono text-[0.6rem] uppercase tracking-[0.16em] text-bone">
              {["digested", "story", "script", "render", "encoded", "export"].map((label, i) => (
                <li key={label} className={milestones[i] ? "text-mercury" : "text-bone/40"}>
                  {milestones[i] ? "●" : "○"} {label}
                </li>
              ))}
            </ol>
          </div>
        </div>
      </StageFrame>
    </>
  );
}
