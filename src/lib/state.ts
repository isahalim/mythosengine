/**
 * State machines for the entities whose legal transitions matter
 * (ARCHITECTURE.md §5). Every transition an entity can legally make lives
 * in exactly one of these maps — a transition not listed is illegal and
 * `assertTransition` throws rather than silently allowing it.
 */

export type SignalState =
  | "observed"
  | "scored"
  | "scripted"
  | "critiqued"
  | "exported"
  | "rejected"
  | "failed";

export type ScriptStatus = "draft" | "approved" | "rejected";
export type RenderStatus = "pending" | "rendered" | "failed";
export type ExportStatus = "ready_for_review" | "downloaded" | "reviewed" | "discarded" | "expired";

const SIGNAL_TRANSITIONS: Record<SignalState, readonly SignalState[]> = {
  observed: ["scored", "rejected", "failed"],
  scored: ["scripted", "rejected", "failed"],
  scripted: ["critiqued", "rejected", "failed"],
  // AUDIT SUMMARY (ARCHITECTURE.md §9) is advisory and never blocks — every
  // critiqued signal that reaches RENDER proceeds straight to EXPORT.
  critiqued: ["exported", "rejected", "failed"],
  exported: [],
  rejected: [],
  failed: [],
};

const SCRIPT_TRANSITIONS: Record<ScriptStatus, readonly ScriptStatus[]> = {
  draft: ["approved", "rejected"],
  approved: [],
  rejected: [],
};

const RENDER_TRANSITIONS: Record<RenderStatus, readonly RenderStatus[]> = {
  pending: ["rendered", "failed"],
  rendered: [],
  failed: [],
};

const EXPORT_TRANSITIONS: Record<ExportStatus, readonly ExportStatus[]> = {
  ready_for_review: ["downloaded", "discarded", "expired"],
  downloaded: ["reviewed", "discarded", "expired"],
  reviewed: [],
  discarded: [],
  expired: [],
};

export class IllegalTransitionError extends Error {
  constructor(entity: string, from: string, to: string) {
    super(`illegal ${entity} transition: ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

function makeAsserter<S extends string>(entity: string, transitions: Record<S, readonly S[]>) {
  return (from: S, to: S): void => {
    if (!transitions[from].includes(to)) {
      throw new IllegalTransitionError(entity, from, to);
    }
  };
}

export const assertSignalTransition = makeAsserter<SignalState>("signal", SIGNAL_TRANSITIONS);
export const assertScriptTransition = makeAsserter<ScriptStatus>("script", SCRIPT_TRANSITIONS);
export const assertRenderTransition = makeAsserter<RenderStatus>("render", RENDER_TRANSITIONS);
export const assertExportTransition = makeAsserter<ExportStatus>("export", EXPORT_TRANSITIONS);
