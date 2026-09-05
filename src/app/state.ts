/**
 * The stage machine — **two routes now** (operator direction, 2026-09-04).
 *
 * Sign in lands on a fork: two free-floating shards, and which one the
 * operator touches decides which set of stages they see.
 *
 *      LANDING   shattered hero + passkey sign-in
 *      FORK      "already have an idea" | "brainstorm first"
 *
 *   brainstorm (the three design boards, 2026-08-31 — unchanged)
 *   1  COUNT     six fragments floating; light one per video you want
 *   2  TOPICS    each lit fragment fuses with a new one and takes a topic
 *   3  IDEAS     a larger fragment is added per video, carrying its story
 *   4  FORGE     agents work; each video is a cracked pane that heals
 *   5  REVIEW    finished videos, downloadable — and run it again
 *
 *   chat (docs/CHAT_PIPELINE.md)
 *   1  COMPOSE   one prompt, plus files; "shatter into reality"
 *   2  BUILDING  the orb rises, gathers the shards, and the card heals
 *   3  REVIEW    the same screen the brainstorm route ends on
 *
 * **The routes share `review` and nothing else.** That is deliberate and it
 * is what the design board asked for — "a dedicated review section for past
 * videos that haven't expired, same as the current step 5 (shares same
 * path)". A finished video is a finished video; where the idea came from
 * changes the audit package, not the review surface.
 *
 * State stays a plain reducer over one object rather than a store: both
 * flows are linear, one run at a time, and every transition is a single
 * operator action. `route` is the only genuinely new axis, and every
 * brainstorm-route branch below is the code that was here before it.
 */
import type { RankedIdea, Topic } from "./types.ts";
import type { TopicChoice } from "./topics.ts";

export const STAGES = ["landing", "fork", "count", "topics", "ideas", "forge", "review", "compose", "building"] as const;
export type Stage = (typeof STAGES)[number];

/** Which way the operator went at the fork. Null until they choose. */
export type Route = "brainstorm" | "chat";

interface RailNode {
  stage: Stage;
  label: string;
}

/** The brainstorm route's five rail nodes, in order, labelled as board 1 labels them. */
const BRAINSTORM_RAIL: RailNode[] = [
  { stage: "count", label: "How many" },
  { stage: "topics", label: "Topics" },
  { stage: "ideas", label: "Ideas" },
  { stage: "forge", label: "Agents deployed" },
  { stage: "review", label: "Review / past work" },
];

/** The chat route's three. Shorter because the operator makes one decision, not three. */
const CHAT_RAIL: RailNode[] = [
  { stage: "compose", label: "Your idea" },
  { stage: "building", label: "Building" },
  { stage: "review", label: "Review / past work" },
];

/**
 * The rail for a route.
 *
 * A function rather than a constant because the two routes have different
 * numbers of steps, and `StageRail` numbers its nodes by position — so the
 * rail array is still the only place that count lives, exactly as the old
 * flat `RAIL` constant was before the fork existed.
 */
export function railFor(route: Route | null): RailNode[] {
  return route === "chat" ? CHAT_RAIL : BRAINSTORM_RAIL;
}

/** One video being specified, then built. `slot` is which floating fragment it started life as. */
export interface VideoSpec {
  slot: number;
  /** What the operator chose on the dial — may be "agent", meaning they declined to name one. */
  topic: TopicChoice | null;
  idea: RankedIdea | null;
  /**
   * The concrete topic the chosen story actually came from. Separate from
   * `topic` because "agent" is not a topic the API accepts: stage 4 ranks
   * across every topic for those videos and records which one won, and
   * that is what gets queued. Queuing "agent" would 422.
   */
  ideaTopic: Topic | null;
}

export interface AppState {
  stage: Stage;
  /** Which way the operator went at the fork. Null on the landing and on the fork itself. */
  route: Route | null;
  /** Which of the six floating fragments are lit. Board 1: "# of glows = # of videos." */
  lit: number[];
  videos: VideoSpec[];
  /** The dispatched run being watched in stage 5 (brainstorm) or on the building screen (chat). */
  traceId: string | null;
  /** Set when dispatch recorded a run it had no credential to actually start — shown verbatim, never swallowed. */
  dispatchNote: string | null;
  /** The chat route's brief, once submitted. Null everywhere else. */
  briefId: string | null;
  /** The prompt the operator typed, kept so the building screen can show it back to them without a round trip. */
  prompt: string | null;
}

export const initialState: AppState = {
  stage: "landing",
  route: null,
  lit: [],
  videos: [],
  traceId: null,
  dispatchNote: null,
  briefId: null,
  prompt: null,
};

export type Action =
  | { type: "signed-in" }
  | { type: "signed-out" }
  | { type: "choose-route"; route: Route }
  | { type: "brief-submitted"; briefId: string; traceId: string | null; prompt: string; note: string | null }
  | { type: "toggle-slot"; slot: number }
  | { type: "confirm-count" }
  | { type: "set-topic"; slot: number; topic: TopicChoice }
  | { type: "confirm-topics" }
  | { type: "set-idea"; slot: number; idea: RankedIdea; ideaTopic: Topic }
  | { type: "dispatched"; traceId: string; note: string | null }
  | { type: "forge-done" }
  | { type: "restart" }
  | { type: "goto"; stage: Stage };

/**
 * How far the operator has actually got — the rail refuses to jump ahead of
 * it.
 *
 * Two branches now, and the brainstorm one is unchanged from the day it was
 * written. The chat one is shorter for the obvious reason: there is one
 * decision on that route, so there is one thing to have done or not done.
 */
export function furthestStage(s: AppState): Stage {
  if (s.stage === "landing") return "landing";
  if (s.route === null) return "fork";

  if (s.route === "chat") {
    if (s.briefId !== null) return s.stage === "review" ? "review" : "building";
    return "compose";
  }

  if (s.traceId !== null) return s.stage === "review" ? "review" : "forge";
  if (s.videos.length > 0 && s.videos.every((v) => v.idea !== null)) return "ideas";
  if (s.videos.length > 0 && s.videos.every((v) => v.topic !== null)) return "ideas";
  if (s.videos.length > 0) return "topics";
  return "count";
}

export function reduce(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "signed-in":
      // The fork, not `count`. Signing in no longer commits the operator to
      // the brainstorm route before they have been asked which one they want.
      return { ...initialState, stage: "fork" };

    case "signed-out":
      return initialState;

    case "choose-route":
      return { ...initialState, route: action.route, stage: action.route === "chat" ? "compose" : "count" };

    case "brief-submitted":
      // `traceId` may be null: `POST /console/briefs` records a real brief
      // even when no dispatch credential is configured, and says so in
      // `note`. The building screen then has a brief to show and no run to
      // poll, which is the honest state and is exactly what it renders.
      return { ...state, stage: "building", briefId: action.briefId, traceId: action.traceId, prompt: action.prompt, dispatchNote: action.note };

    case "toggle-slot": {
      const lit = state.lit.includes(action.slot) ? state.lit.filter((s) => s !== action.slot) : [...state.lit, action.slot].sort((a, b) => a - b);
      return { ...state, lit };
    }

    case "confirm-count":
      // The lit fragments become the videos, in the order they sit on the
      // arc — so slot identity survives every later stage and each video
      // keeps the same piece of glass all the way to the forge.
      return {
        ...state,
        stage: "topics",
        videos: state.lit.map((slot) => ({ slot, topic: null, idea: null, ideaTopic: null })),
      };

    case "set-topic":
      return {
        ...state,
        // Changing a topic invalidates the idea chosen under the old one —
        // silently keeping it would queue a story the operator never
        // picked for that topic.
        videos: state.videos.map((v) =>
          v.slot === action.slot
            ? { ...v, topic: action.topic, ...(v.topic === action.topic ? {} : { idea: null, ideaTopic: null }) }
            : v,
        ),
      };

    case "confirm-topics":
      return { ...state, stage: "ideas" };

    case "set-idea":
      return {
        ...state,
        videos: state.videos.map((v) => (v.slot === action.slot ? { ...v, idea: action.idea, ideaTopic: action.ideaTopic } : v)),
      };

    case "dispatched":
      return { ...state, stage: "forge", traceId: action.traceId, dispatchNote: action.note };

    case "forge-done":
      return { ...state, stage: "review" };

    case "restart":
      // Board 3 stage 6: "then user can repeat the process and the stages
      // happen again one by one." Back to the fork rather than to `count`,
      // because "again" no longer means one thing — the operator may want
      // the other route this time.
      return { ...initialState, stage: "fork" };

    case "goto":
      return { ...state, stage: action.stage };
  }
}

/** Stage 3 is finished when every video has a topic; stage 4 when every one has a story. */
export function topicsComplete(s: AppState): boolean {
  return s.videos.length > 0 && s.videos.every((v) => v.topic !== null);
}

export function ideasComplete(s: AppState): boolean {
  return s.videos.length > 0 && s.videos.every((v) => v.idea !== null);
}
