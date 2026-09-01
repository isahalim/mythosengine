/**
 * The six-stage machine (the three design boards, 2026-08-31).
 *
 *   1  LANDING   shattered hero + passkey sign-in
 *   2  COUNT     six fragments floating; light one per video you want
 *   3  TOPICS    each lit fragment fuses with a new one and takes a topic
 *   4  IDEAS     a larger fragment is added per video, carrying its story
 *   5  FORGE     agents work; each video is a cracked pane that heals
 *   6  REVIEW    finished videos, downloadable — and run it again
 *
 * Stages 2-6 are the five nodes on the bubble rail (board 1); stage 1 is
 * the landing, which has no rail. State is deliberately a plain reducer
 * over one object rather than a store: the whole flow is linear, one run
 * at a time, and every transition is a single operator action.
 */
import type { RankedIdea, Topic } from "./types.ts";
import type { TopicChoice } from "./topics.ts";

export const STAGES = ["landing", "count", "topics", "ideas", "forge", "review"] as const;
export type Stage = (typeof STAGES)[number];

/** The five rail nodes, in order, labelled as board 1 labels them. */
export const RAIL: { stage: Stage; label: string }[] = [
  { stage: "count", label: "How many" },
  { stage: "topics", label: "Topics" },
  { stage: "ideas", label: "Ideas" },
  { stage: "forge", label: "Agents deployed" },
  { stage: "review", label: "Review / past work" },
];

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
  /** Which of the six floating fragments are lit. Board 1: "# of glows = # of videos." */
  lit: number[];
  videos: VideoSpec[];
  /** The dispatched run being watched in stage 5. */
  traceId: string | null;
  /** Set when dispatch recorded a run it had no credential to actually start — shown verbatim, never swallowed. */
  dispatchNote: string | null;
}

export const initialState: AppState = {
  stage: "landing",
  lit: [],
  videos: [],
  traceId: null,
  dispatchNote: null,
};

export type Action =
  | { type: "signed-in" }
  | { type: "signed-out" }
  | { type: "toggle-slot"; slot: number }
  | { type: "confirm-count" }
  | { type: "set-topic"; slot: number; topic: TopicChoice }
  | { type: "confirm-topics" }
  | { type: "set-idea"; slot: number; idea: RankedIdea; ideaTopic: Topic }
  | { type: "dispatched"; traceId: string; note: string | null }
  | { type: "forge-done" }
  | { type: "restart" }
  | { type: "goto"; stage: Stage };

/** How far the operator has actually got — the rail refuses to jump ahead of it. */
export function furthestStage(s: AppState): Stage {
  if (s.stage === "landing") return "landing";
  if (s.traceId !== null) return s.stage === "review" ? "review" : "forge";
  if (s.videos.length > 0 && s.videos.every((v) => v.idea !== null)) return "ideas";
  if (s.videos.length > 0 && s.videos.every((v) => v.topic !== null)) return "ideas";
  if (s.videos.length > 0) return "topics";
  return "count";
}

export function reduce(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "signed-in":
      return { ...initialState, stage: "count" };

    case "signed-out":
      return initialState;

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
      // happen again one by one."
      return { ...initialState, stage: "count" };

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
