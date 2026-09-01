/**
 * The sourcing process, stage 5 (operator direction 2026-09-01: "make the
 * agents deployed section have a robust instruction/process ... make the
 * agents make a proper plan so they can execute it properly").
 *
 * A list of the shots PLAN wrote, each showing what it is for, where it is
 * being looked for, and how far it actually got. Every status here is a row
 * the pipeline wrote *after* doing the thing — the same contract the rest of
 * this stage holds to. There is no progress bar and no percentage, because
 * neither would be a fact.
 *
 * Beside the forge pane rather than inside it: the glass is the video, and
 * this is the paperwork. Putting it in the glass would have meant either
 * covering the fracture or shrinking the shots to illegibility.
 */
import type { RunShot } from "../types.ts";

/** The order the pipeline moves through. `failed` sits outside it — it is an end, not a step. */
const ORDER: RunShot["status"][] = ["planned", "searching", "downloading", "clipped", "composited"];

const LABEL: Record<RunShot["status"], string> = {
  planned: "planned",
  searching: "searching",
  downloading: "downloading",
  clipped: "clipped",
  composited: "in the video",
  failed: "failed",
};

function statusClass(status: RunShot["status"]): string {
  if (status === "failed") return "text-rose";
  if (status === "composited") return "text-oxide";
  if (status === "planned") return "text-bone";
  return "text-sodium";
}

export function ShotPlanPanel({ shots }: { shots: RunShot[] }) {
  if (shots.length === 0) return null;

  const done = shots.filter((shot) => shot.status === "composited").length;

  return (
    <div className="resolve-in rounded-xl border border-mercury/15 bg-white/40 px-3 py-2">
      <p className="mb-1.5 font-mono text-[0.6rem] uppercase tracking-[0.16em] text-bone">
        shot plan · {done}/{shots.length} in the video
      </p>

      <ol className="flex flex-col gap-1">
        {shots.map((shot) => (
          <li key={shot.position} className="flex items-baseline gap-2 text-[0.62rem] leading-snug">
            <span className="w-3 shrink-0 font-mono text-bone">{shot.position + 1}</span>
            <span className="shrink-0 rounded bg-mercury/15 px-1 font-mono text-[0.55rem] uppercase text-bone">{shot.source}</span>
            <span className="min-w-0 flex-1">
              {/* The query, because "why is there a chessboard in a video
                  about determinism" is a question about the search and is
                  not answerable from the clip. */}
              <span className="text-mercury">{shot.query}</span>
              {shot.intent.length > 0 && <span className="text-bone"> — {shot.intent}</span>}
              {/* A failure says what happened. A shot that quietly vanished
                  would leave the operator counting shots to notice. */}
              {shot.error !== null && <span className="text-rose"> · {shot.error}</span>}
            </span>
            <span className={`shrink-0 font-mono text-[0.55rem] uppercase ${statusClass(shot.status)}`}>
              {LABEL[shot.status]}
              {shot.status !== "failed" && ORDER.indexOf(shot.status) >= 0 && (
                <span className="text-bone"> {ORDER.indexOf(shot.status) + 1}/{ORDER.length}</span>
              )}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
