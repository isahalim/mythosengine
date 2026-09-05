import { useEffect, useMemo, useState } from "react";
import { describeError, getBrief, getRunProgress, isUnauthorized, streamExportUrl } from "../api.ts";
import { ForgePane } from "../glass/ForgePane.tsx";
import { ShardPlayer } from "../glass/ShardPlayer.tsx";
import { MetadataPanel } from "../stages/MetadataPanel.tsx";
import type { BriefView, RunProgress } from "../types.ts";
import { parseDigest } from "../types.ts";
import { StageFrame } from "../ui/StageFrame.tsx";
import { ExportActions } from "./ExportActions.tsx";
import { OrbField } from "./OrbField.tsx";
import { milestoneFraction } from "./progress.ts";

/**
 * The chat route's second screen — panels 2 and 3 of the design board, on one
 * surface.
 *
 * The sequence, as drawn:
 *
 *   1. The orb rises and settles **dead centre of the video card** (operator
 *      direction, 2026-09-05: "make sure the orb is in the center as the
 *      video card gets slowly formed"). It replaces both the board's black
 *      hole and its aurora (operator direction, 2026-09-04): "instead of
 *      using the aurora use the gradient orb and make it smoothly and
 *      fluid-like to emerge from the text input place and drift upwards
 *      gently".
 *
 *      **The orb is rendered by `OrbField`, not here.** It is several times
 *      the width of the card and this column scrolls and clips, so inside it
 *      the orb would be cut to the card's own box. This screen owns *when* it
 *      rises and when it goes, and marks the element it centres on.
 *   2. The input locks — "won't accept anything until run ends (success or
 *      fails)". The prompt stays visible above it, greyed, so the operator can
 *      see what they asked for.
 *   3. **As each pipeline stage lands**, the video card gains one fragment,
 *      free floating in place. There is nothing flying into it: the orbiting
 *      shards, the trailing debris and the crack lines the card used to heal
 *      along were all removed on 2026-09-05 by operator direction ("I want to
 *      make the design more simple, so completely remove the orbiting glass
 *      shards and debris ... The glass shards should settle in free float to
 *      make the video card, but without any guidance of those purple lines").
 *      The counted facts are unchanged; only what was drawn around them is
 *      gone.
 *   4. Whole, the card becomes a `ShardPlayer` — the same sealed → cracked →
 *      open → autoplay progression the landing demo and stage 6 use — and the
 *      orb fades out at that moment rather than waiting to be clicked
 *      (operator direction, 2026-09-05).
 *   5. Download · Review · Metadata · Discard underneath.
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
  if (done <= 2 && digest !== null) return `Researching “${digest.title}”…`;
  if (done <= 3) return "Writing the script…";
  if (done <= 4) return "Sourcing footage, narrating, cutting…";
  if (done <= 5) return "Rendering…";
  return "Done.";
}

export function StageBuilding({ briefId, traceId, prompt, dispatchNote, onReview, onUnauthorized }: StageBuildingProps) {
  const [brief, setBrief] = useState<BriefView | null>(null);
  const [progress, setProgress] = useState<RunProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [risen, setRisen] = useState(false);
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
  const fraction = milestoneFraction(milestones);
  const video = progress?.videos[0] ?? null;
  const exportId = video?.exportId ?? null;
  const running = brief?.status !== "failed" && progress?.status !== "failed" && exportId === null;

  return (
    <>
      {/* The orb, behind everything, centred on the card below. It goes when
          the export lands — the card is whole, and the orb was the thing
          standing in for the video that did not exist yet. */}
      <OrbField active={risen} healed={exportId !== null} anchor={`[data-orb-anchor="${briefId}"]`} />

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

          {/*
            Scrolls (operator direction, 2026-09-05: "allow scrolling in the
            2nd step of the chat route so that once the video is done, the
            user can actually scroll to view the metadata"). The frame around
            it is `h-dvh` and the body is `overflow: hidden` — the stage
            machine owns the viewport and each stage scrolls internally,
            which stage 6 already does with this exact pair of classes. The
            finished state is a 9:16 player, four buttons and a metadata
            sheet, and on anything shorter than a desktop that is taller than
            what is left of the viewport: the sheet was on screen but
            unreachable.

            `overflow-x` follows `overflow-y` to `auto` whether it is asked
            to or not, so a fragment lifting toward the cursor is clipped at
            this box's edge. That is the cost of a scrollport and it is paid
            where the alternative is content nobody can reach.
          */}
          {/*
            The card is capped by the viewport's HEIGHT as well as its width
            (`min(16rem, 24vh)`, and 24vh of width is 43vh of a 9:16 card),
            and this column carries `pt-6` above it (operator direction,
            2026-09-05: "move the video card down so it doesn't clip at the
            top").

            A flat `16rem` is 455px of card, and the finished state is that
            card plus a caption, four buttons and a metadata sheet — taller
            than what is left of a laptop's viewport under the header and the
            locked prompt. The column scrolled, and scrolling it put the top
            of the video under this box's edge, which is what the operator
            was looking at. Bounding the card is what removes the scroll on
            an ordinary window; the padding is what keeps its top edge off
            this box's own edge when the metadata sheet does make it scroll.
          */}
          <div className="relative z-10 mt-6 flex min-h-0 w-full flex-1 flex-col items-center overflow-y-auto pb-8 pt-6">
            {/* Before the export exists the card is cracked glass healing as
                the run advances; after it, it is the finished video in the
                same pane. `fracture` is `1 - done/6` — counted facts, not a
                curve. */}
            {exportId === null ? (
              /* The anchor: `OrbField` measures this box every frame and
                 centres the orb on it. Keyed by brief id so the selector
                 cannot match a stale node left by a previous screen. */
              <div className="w-1/2 max-w-[min(16rem,24vh)]" data-orb-anchor={briefId}>
                {/*
                  `assembled` is what makes the card BUILD rather than sit
                  there healing (operator direction, 2026-09-05: "don't
                  pre-make the shards ... they should slowly get placed one by
                  one as the pipeline progresses just like how it is in the
                  demo's video card progression"). The pane used to render all
                  eight fragments from the first frame and only fade its crack
                  lines, so the card was already whole before anything had
                  happened. It starts empty and takes a fragment as each
                  milestone lands.

                  Passing `assembled` also takes the crack lines off this card
                  entirely (operator direction, 2026-09-05: "there shouldn't
                  be a empty purple frame ... without any guidance of those
                  purple lines"). At zero milestones the pane had no fragments
                  and a full-strength fracture, which drew a violet wireframe
                  of a card that did not exist yet — a promise of a shape
                  rather than a fact about the run. `fracture` still rides the
                  same counted fraction, and it now reaches only the glow.
                */}
                <ForgePane fracture={1 - fraction} assembled={fraction} glow="var(--violet)" clips={[]} working={running} />
              </div>
            ) : (
              <>
                <div className="w-1/2 max-w-[min(16rem,24vh)]" data-orb-anchor={briefId}>
                  <ShardPlayer
                    src={streamExportUrl(exportId)}
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
                  /* No scrollport of its own: the column above is the one
                     that scrolls, and a panel that scrolled inside it would
                     put the operator in a two-pixel gutter to read a sheet
                     the page could simply be longer for. */
                  <div className="mt-4 w-full">
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
