/**
 * The shell every stage after the landing renders into: a title, a line of
 * explanation, the stage's own surface, and a footer for its one forward
 * action.
 *
 * Board 2: "new UI elements fade in effect (image generation effect)" —
 * hence .resolve-in, which sharpens elements out of a blur rather than
 * sliding them in. Keyed on the stage in App.tsx so it replays per stage.
 *
 * POINTER TRANSPARENCY (operator direction, 2026-08-31 — "the glass shards
 * at the edges need to have the highlight hover effect and also tilt").
 * They already did, in code: EdgeFrame runs the same useShardField loop as
 * every other fragment. They were unreachable, because this element is a
 * full-viewport box at z-10 and the edge frame sits at z-0 behind it — so
 * every pointermove was consumed here and the border fragments never saw
 * one.
 *
 * The fix is to make the CHROME transparent to the pointer rather than to
 * move the glass: the root and the stage's content box pass events through,
 * and the things that actually want them opt back in. `.shard` and
 * `.float-group` already declare `pointer-events: auto` in shards.css, and
 * a descendant with `auto` inside a `none` ancestor is still hit-tested, so
 * every fragment stays interactive while the empty space around it does not
 * block the border.
 */
import type { ReactNode } from "react";

interface StageFrameProps {
  eyebrow: string;
  title: string;
  blurb: string;
  children: ReactNode;
  footer?: ReactNode;
}

export function StageFrame({ eyebrow, title, blurb, children, footer }: StageFrameProps) {
  return (
    <div className="pointer-events-none relative z-10 flex h-dvh flex-col items-center px-4 pb-6 pt-20 sm:px-8 sm:pt-24">
      <header className="resolve-in pointer-events-auto shrink-0 text-center" style={{ animationDelay: "60ms" }}>
        <p className="font-mono text-[0.65rem] uppercase tracking-[0.22em] text-bone">{eyebrow}</p>
        <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight text-mercury sm:text-3xl">{title}</h1>
        <p className="mx-auto mt-2 max-w-xl text-sm text-bone">{blurb}</p>
      </header>

      <div className="pointer-events-none relative mt-6 min-h-0 w-full flex-1">{children}</div>

      {footer && (
        <footer className="resolve-in pointer-events-auto mt-4 flex shrink-0 items-center gap-3" style={{ animationDelay: "220ms" }}>
          {footer}
        </footer>
      )}
    </div>
  );
}
