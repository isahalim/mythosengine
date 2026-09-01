/**
 * The bubble progress bar — board 1 stage 2: five numbered nodes on a
 * hairline, one per stage after the landing.
 *
 * A node is reachable only if the operator has actually been that far
 * (state.ts's furthestStage): the rail reports progress and lets you step
 * back to revise, it never lets you skip work the next stage depends on.
 *
 * Review is the exception, and always reachable. It is called "Review /
 * past work" and it is exactly that — a read-only view of every export
 * still in the queue, including ones from runs finished days ago. Gating
 * it behind the *current* run having produced something meant the
 * operator could not look at their own finished videos until they had
 * specified a whole new run, which is the opposite of what the label
 * promises.
 */
import { RAIL, STAGES, type Stage } from "../state.ts";

interface StageRailProps {
  current: Stage;
  furthest: Stage;
  onGoto: (stage: Stage) => void;
}

function indexOf(stage: Stage): number {
  return STAGES.indexOf(stage);
}

export function StageRail({ current, furthest, onGoto }: StageRailProps) {
  const currentIdx = indexOf(current);
  const furthestIdx = indexOf(furthest);

  return (
    <nav className="pointer-events-auto flex items-center gap-1 sm:gap-2" aria-label="Run progress">
      {RAIL.map(({ stage, label }, i) => {
        const idx = indexOf(stage);
        const done = idx < currentIdx;
        const active = stage === current;
        const reachable = idx <= furthestIdx || stage === "review";

        return (
          <div key={stage} className="flex items-center gap-1 sm:gap-2">
            {i > 0 && <span aria-hidden="true" className={`h-px w-4 sm:w-8 ${done || active ? "bg-mercury/35" : "bg-hairline"}`} />}
            <button
              type="button"
              disabled={!reachable}
              onClick={() => onGoto(stage)}
              aria-current={active ? "step" : undefined}
              className={[
                "group flex items-center gap-2 rounded-full py-1 pl-1 pr-1 transition-all duration-300 sm:pr-3",
                reachable ? "cursor-pointer" : "cursor-not-allowed",
                active ? "bg-slate/80 shadow-[var(--shadow-1)] sm:pr-3" : "",
              ].join(" ")}
            >
              <span
                className={[
                  "grid h-6 w-6 place-items-center rounded-full font-mono text-[0.65rem] transition-all duration-300",
                  active
                    ? "bg-mercury text-ink shadow-[var(--shadow-2)]"
                    : done
                      ? "bg-mercury/12 text-mercury"
                      : reachable
                        ? "border border-hairline bg-ink text-bone"
                        : "border border-hairline bg-ink text-bone/40",
                ].join(" ")}
              >
                {i + 1}
              </span>
              <span
                className={[
                  "hidden whitespace-nowrap text-xs transition-colors sm:inline",
                  active ? "font-medium text-mercury" : reachable ? "text-bone" : "text-bone/40",
                ].join(" ")}
              >
                {label}
              </span>
            </button>
          </div>
        );
      })}
    </nav>
  );
}
