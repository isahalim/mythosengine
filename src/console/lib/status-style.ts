// Status -> Tailwind class maps shared by every script that renders a
// status pill/dot at runtime (keys.ts, review-queue.ts, dashboard.ts).
// Centralized here instead of duplicated per file, and separate from the
// Astro components (which only ever render at build time under
// output: "static" — see docs/DECISIONS.md's Phase 7 entry).
import type { ExportStatus, LiveStatus } from "./types.ts";

export const EXPORT_STATUS_PILL: Record<ExportStatus, string> = {
  ready_for_review: "bg-sodium/15 text-sodium border-sodium/30",
  downloaded: "bg-violet/15 text-violet border-violet/30",
  reviewed: "bg-oxide/15 text-oxide border-oxide/30",
  discarded: "bg-mercury/10 text-mercury/60 border-mercury/20",
  expired: "bg-rose/15 text-rose border-rose/30",
};

export const LIVE_STATUS_DOT: Record<LiveStatus, string> = {
  live: "bg-oxide",
  degraded: "bg-sodium",
  down: "bg-rose",
  unknown: "bg-mercury/40",
};

export const LIVE_STATUS_TEXT: Record<LiveStatus, string> = {
  live: "text-oxide",
  degraded: "text-sodium",
  down: "text-rose",
  unknown: "text-mercury/60",
};
