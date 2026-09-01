/** Board 1 stage 2: wordmark left, the rail across the middle, sign out right. */
import type { Stage } from "../state.ts";
import { StageRail } from "./StageRail.tsx";
import { Button } from "./Button.tsx";

interface TopBarProps {
  current: Stage;
  furthest: Stage;
  onGoto: (stage: Stage) => void;
  onSignOut: () => void;
  signingOut: boolean;
}

export function TopBar({ current, furthest, onGoto, onSignOut, signingOut }: TopBarProps) {
  return (
    <header className="pointer-events-none fixed inset-x-0 top-0 z-30 flex items-center justify-between gap-4 px-4 py-4 sm:px-8">
      <span className="pointer-events-auto font-display text-sm font-semibold tracking-tight text-mercury">Mythos Engine</span>

      <div className="absolute left-1/2 hidden -translate-x-1/2 md:block">
        <StageRail current={current} furthest={furthest} onGoto={onGoto} />
      </div>

      <Button variant="ghost" className="pointer-events-auto !px-3 !py-1.5 !text-xs" onClick={onSignOut} disabled={signingOut}>
        {signingOut ? "Signing out…" : "Sign out"}
      </Button>
    </header>
  );
}
