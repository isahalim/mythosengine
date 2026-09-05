/** Board 1 stage 2: wordmark left, the rail across the middle, sign out right. */
import type { Route, Stage } from "../state.ts";
import { StageRail } from "./StageRail.tsx";
import { Button } from "./Button.tsx";

interface TopBarProps {
  current: Stage;
  furthest: Stage;
  /**
   * Which route's rail to draw. The two have different numbers of steps, so
   * the rail cannot be a constant any more — `railFor` in state.ts is still
   * the only place either count lives.
   */
  route: Route | null;
  onGoto: (stage: Stage) => void;
  onSignOut: () => void;
  signingOut: boolean;
}

export function TopBar({ current, furthest, route, onGoto, onSignOut, signingOut }: TopBarProps) {
  return (
    <header className="pointer-events-none fixed inset-x-0 top-0 z-30 flex items-center justify-between gap-4 px-4 py-4 sm:px-8">
      <span className="pointer-events-auto font-display text-sm font-semibold tracking-tight text-mercury">Mythos Engine</span>

      {/* No rail on the fork: the operator has not chosen a route, so there
          is no sequence to be partway through. */}
      {route !== null && (
        <div className="absolute left-1/2 hidden -translate-x-1/2 md:block">
          <StageRail current={current} furthest={furthest} route={route} onGoto={onGoto} />
        </div>
      )}

      <div className="pointer-events-auto flex items-center gap-2">
        {/*
          The dedicated Review entry the chat design board asks for: "in the
          menu bar there should be a dedicated review section for past videos
          that haven't expired, same as the current step 5 (shares same path)."

          It is on both routes and it goes to the same screen, which is the
          point — a finished video is a finished video, and where its idea
          came from changes the audit package rather than the review surface.
          On the fork it is the one thing reachable without choosing a route,
          because looking at last week's work is not a new run.
        */}
        {current !== "review" && (
          <Button variant="ghost" className="!px-3 !py-1.5 !text-xs" onClick={() => onGoto("review")}>
            Review
          </Button>
        )}
        <Button variant="ghost" className="!px-3 !py-1.5 !text-xs" onClick={onSignOut} disabled={signingOut}>
          {signingOut ? "Signing out…" : "Sign out"}
        </Button>
      </div>
    </header>
  );
}
