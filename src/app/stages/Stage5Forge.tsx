/**
 * Stage 5 — agents deployed (board 3).
 *
 * A pane per video, each one a cracked sheet the pipeline is repairing.
 * Everything on screen is read from a row: which stages the run actually
 * recorded, which videos actually have a script, a render, an export. No
 * percentage is interpolated and no finish time is estimated
 * (src/server/console/runs.ts's own contract).
 *
 * "not_triggered" is a real state, not an error: POST /console/dispatch
 * records a run it has no workflow_dispatch credential to actually start,
 * and the honest thing is to say so rather than spin forever.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { describeError, getRunMontage, getRunProgress, isUnauthorized } from "../api.ts";
import { ForgePane } from "../glass/ForgePane.tsx";
import { FloatingField, ringPositions } from "../glass/FloatingField.tsx";
import { topicColor } from "../topics.ts";
import type { VideoSpec } from "../state.ts";
import type { MontageClip, RunProgress, RunVideo } from "../types.ts";
import { Button } from "../ui/Button.tsx";
import { StageFrame } from "../ui/StageFrame.tsx";
import { ShotPlanPanel } from "./ShotPlanPanel.tsx";

const POLL_MS = 5_000;

/**
 * The four things that are observably true or not for one video, in the
 * order the pipeline makes them true. Fracture is 1 minus the fraction of
 * these that hold — a count of facts, not a guess at progress.
 */
function milestones(v: RunVideo): boolean[] {
  return [true, v.renderId !== null, v.renderStatus === "rendered", v.exportId !== null];
}

function fractureOf(v: RunVideo): number {
  const m = milestones(v);
  return 1 - m.filter(Boolean).length / m.length;
}

interface Stage5Props {
  traceId: string;
  videos: VideoSpec[];
  dispatchNote: string | null;
  onDone: () => void;
  onUnauthorized: () => void;
}

export function Stage5Forge({ traceId, videos, dispatchNote, onDone, onUnauthorized }: Stage5Props) {
  const [progress, setProgress] = useState<RunProgress | null>(null);
  const [clipsByScript, setClipsByScript] = useState<Record<string, MontageClip[]>>({});
  const [montageNote, setMontageNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const montageFetched = useRef(false);

  // Poll the run. Stops as soon as the run reaches a terminal state, so a
  // finished run is not still being asked about ten minutes later.
  useEffect(() => {
    let cancelled = false;
    let timer = 0;

    const poll = async (): Promise<void> => {
      const result = await getRunProgress(traceId);
      if (cancelled) return;

      if (!result.ok) {
        if (isUnauthorized(result.error)) {
          onUnauthorized();
          return;
        }
        setError(describeError(result.error));
      } else {
        setError(null);
        setProgress(result.value);
        const terminal = result.value.status === "succeeded" || result.value.status === "failed" || result.value.status === "not_triggered";
        if (terminal) return;
      }
      timer = window.setTimeout(() => void poll(), POLL_MS);
    };

    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [traceId, onUnauthorized]);

  // The montage is fetched once, not per poll: it reaches Pexels
  // server-side and its clips do not change as the run advances.
  useEffect(() => {
    if (montageFetched.current) return;
    if (progress === null || progress.videos.length === 0) return;
    montageFetched.current = true;

    void getRunMontage(traceId).then((result) => {
      if (!result.ok) {
        setMontageNote("Preview footage is unavailable — the shards show the run without it.");
        return;
      }
      if (!result.value.configured) {
        setMontageNote("No Pexels key is configured, so there is no preview footage to show.");
        return;
      }
      const next: Record<string, MontageClip[]> = {};
      for (const v of result.value.videos) next[v.scriptId] = v.clips;
      setClipsByScript(next);
      if (result.value.failures.length > 0) {
        setMontageNote(`${result.value.failures.length} keyword${result.value.failures.length === 1 ? "" : "s"} returned no preview footage.`);
      }
    });
  }, [progress, traceId]);

  const status = progress?.status ?? "queued";
  const running = status === "queued" || status === "running";
  const lastStage = progress?.stages.at(-1) ?? null;
  const ready = progress?.videos.filter((v) => v.exportId !== null).length ?? 0;
  const total = progress?.videos.length ?? videos.length;
  const positions = ringPositions(progress?.videos.length ?? 0);

  return (
    <StageFrame
      eyebrow="Step 4 of 5"
      title={status === "not_triggered" ? "Recorded, but not started" : running ? "The agents are working" : status === "failed" ? "The run failed" : "Rendered"}
      blurb={
        status === "not_triggered"
          ? "This run exists in the database but no workflow was triggered — there is no dispatch credential configured."
          : "Each pane is one video. The shot plan under it is what the agents are sourcing, shot by shot; the cracks close as the pipeline records real milestones — a script, a render, an export."
      }
      footer={
        <>
          <span className="font-mono text-xs text-bone">
            {ready} / {total} exported
          </span>
          <Button variant="primary" disabled={ready === 0} onClick={onDone}>
            Review {ready > 0 ? `${ready} ` : ""}→
          </Button>
        </>
      }
    >
      <div className="flex h-full flex-col gap-3">
        {/* Every abnormal state is stated plainly rather than hidden
            behind a spinner that would imply work is happening. */}
        {dispatchNote !== null && (
          <p className="resolve-in shrink-0 rounded-xl border border-sodium/25 bg-sodium/5 px-4 py-2 font-mono text-xs text-sodium">{dispatchNote}</p>
        )}
        {error !== null && (
          <p className="resolve-in shrink-0 rounded-xl border border-rose/25 bg-rose/5 px-4 py-2 font-mono text-xs text-rose">
            Could not read the run: {error}
          </p>
        )}
        {montageNote !== null && <p className="shrink-0 font-mono text-[0.68rem] text-bone">{montageNote}</p>}

        {lastStage !== null && (
          <p className="shrink-0 font-mono text-[0.68rem] uppercase tracking-[0.16em] text-bone">
            {lastStage.stage} · {lastStage.status}
            {lastStage.errorClass !== null && <span className="text-rose"> · {lastStage.errorClass}</span>}
          </p>
        )}

        <div className="relative min-h-0 flex-1">
          <FloatingField>
            {(progress?.videos ?? []).map((video, i) => {
              const spec = videos[i];
              const hue = spec?.ideaTopic == null ? "var(--violet)" : topicColor(spec.ideaTopic);
              const box = positions[i] ?? { x: 40, y: 20, w: 20, h: 60 };
              return (
                <div
                  key={video.scriptId}
                  className="float-group"
                  style={
                    {
                      left: `${box.x}%`,
                      top: `${box.y}%`,
                      width: `${box.w}%`,
                      "--float-dur": `${12 + i * 1.7}s`,
                      "--float-delay": `${-i * 2.3}s`,
                      "--float-x": `${10 + i * 3}px`,
                      "--float-y": `${14 + i * 2}px`,
                      "--float-rot": `${1 + i * 0.3}deg`,
                    } as CSSProperties
                  }
                >
                  {/* Its own cut, so the videos in a run are visibly
                      different panes rather than one repeated. */}
                  <ForgePane fracture={fractureOf(video)} glow={hue} clips={clipsByScript[video.scriptId] ?? []} working={running} variant={i} />
                  <p className="mt-2 line-clamp-2 text-center text-[0.66rem] leading-snug text-bone">{video.hook}</p>
                  {/* The paperwork beside the glass: what the agents planned
                      to find, and what they have actually found so far. */}
                  <div className="mt-2">
                    <ShotPlanPanel shots={video.shots} />
                  </div>
                </div>
              );
            })}
          </FloatingField>

          {/* Before SCRIPT has written anything there is nothing to show,
              and saying so beats floating empty cards that imply videos
              exist. */}
          {(progress?.videos.length ?? 0) === 0 && (
            <p className="absolute inset-x-0 top-10 text-center font-mono text-xs text-bone">
              {status === "not_triggered" ? "No workflow ran, so no scripts were written." : "Waiting for the first script to be written…"}
            </p>
          )}
        </div>

        {Object.keys(clipsByScript).length > 0 && (
          // CLAUDE.md: footage provenance is never implied. These stills
          // are a preview of the script's keywords, not the footage in the
          // video, and the UI has to keep saying so.
          <p className="shrink-0 text-[0.65rem] leading-relaxed text-bone">
            Hover a fragment to see what it is holding — a preview still from Pexels for one of this script&apos;s keywords. Previews are not the footage:
            the shot plan under each pane is what the agents actually sourced, and every finished video&apos;s audit package names each clip, its provider
            and the search that found it.
          </p>
        )}
      </div>
    </StageFrame>
  );
}
