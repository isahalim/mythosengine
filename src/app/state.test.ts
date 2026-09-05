import { describe, expect, it } from "vitest";
import { furthestStage, ideasComplete, initialState, railFor, reduce, topicsComplete, type Action, type AppState } from "./state.ts";
import type { RankedIdea } from "./types.ts";

/**
 * The stage machine, with the fork in it (2026-09-04).
 *
 * Half of this file is a **regression guard**: the brainstorm route was
 * working before the chat route existed and must be unchanged by it, so its
 * whole path is walked here end to end. The other half is the fork and the
 * chat route.
 */

const IDEA: RankedIdea = {
  signalId: "sig1",
  title: "A story",
  url: "https://example.com/1",
  sourceKind: "rss",
  observedAt: "2026-09-04T00:00:00.000Z",
  engagementScore: 1,
  relevance: 1,
  matchedTerms: 2,
  freshness: 1,
  score: 1,
};

/** Applies a sequence of actions to the initial state, which is how every path below is expressed. */
function run(...actions: Action[]): AppState {
  return actions.reduce(reduce, initialState);
}

describe("the fork", () => {
  it("lands on the fork after signing in, not on a route", () => {
    const state = run({ type: "signed-in" });
    expect(state.stage).toBe("fork");
    expect(state.route).toBeNull();
  });

  it("sends each choice to its own first stage", () => {
    expect(run({ type: "signed-in" }, { type: "choose-route", route: "brainstorm" })).toMatchObject({ stage: "count", route: "brainstorm" });
    expect(run({ type: "signed-in" }, { type: "choose-route", route: "chat" })).toMatchObject({ stage: "compose", route: "chat" });
  });

  it("returns to the fork on restart, because 'again' no longer means one thing", () => {
    const state = run({ type: "signed-in" }, { type: "choose-route", route: "chat" }, { type: "restart" });
    expect(state.stage).toBe("fork");
    expect(state.route).toBeNull();
  });

  it("clears everything on sign-out", () => {
    const state = run({ type: "signed-in" }, { type: "choose-route", route: "chat" }, { type: "brief-submitted", briefId: "b1", traceId: "t1", prompt: "p", note: null }, { type: "signed-out" });
    expect(state).toEqual(initialState);
  });

  it("gives each route its own rail, and both of them end at review", () => {
    expect(railFor("brainstorm")).toHaveLength(5);
    expect(railFor("chat")).toHaveLength(3);
    expect(railFor("brainstorm").at(-1)?.stage).toBe("review");
    expect(railFor("chat").at(-1)?.stage).toBe("review");
    // No route yet (the fork itself): the brainstorm rail is the harmless
    // default, and TopBar draws no rail at all there anyway.
    expect(railFor(null)).toEqual(railFor("brainstorm"));
  });
});

describe("the chat route", () => {
  const submitted = run({ type: "signed-in" }, { type: "choose-route", route: "chat" }, { type: "brief-submitted", briefId: "b1", traceId: "t1", prompt: "make a video on AI", note: null });

  it("moves to the building screen carrying the brief, the trace and the prompt", () => {
    expect(submitted).toMatchObject({ stage: "building", briefId: "b1", traceId: "t1", prompt: "make a video on AI" });
  });

  it("accepts a null trace — a brief can be recorded without a run being started", () => {
    const state = run({ type: "signed-in" }, { type: "choose-route", route: "chat" }, { type: "brief-submitted", briefId: "b1", traceId: null, prompt: "p", note: "recorded, not triggered" });
    expect(state.traceId).toBeNull();
    expect(state.dispatchNote).toBe("recorded, not triggered");
  });

  it("reports progress as compose until a brief exists, then building", () => {
    expect(furthestStage(run({ type: "signed-in" }, { type: "choose-route", route: "chat" }))).toBe("compose");
    expect(furthestStage(submitted)).toBe("building");
    expect(furthestStage({ ...submitted, stage: "review" })).toBe("review");
  });
});

describe("the brainstorm route is unchanged", () => {
  const start: Action[] = [{ type: "signed-in" }, { type: "choose-route", route: "brainstorm" }];

  it("lights fragments, and toggling one twice puts it out again", () => {
    expect(run(...start, { type: "toggle-slot", slot: 2 }, { type: "toggle-slot", slot: 0 }).lit).toEqual([0, 2]);
    expect(run(...start, { type: "toggle-slot", slot: 2 }, { type: "toggle-slot", slot: 2 }).lit).toEqual([]);
  });

  it("turns the lit fragments into videos, in arc order, so slot identity survives every later stage", () => {
    const state = run(...start, { type: "toggle-slot", slot: 4 }, { type: "toggle-slot", slot: 1 }, { type: "confirm-count" });
    expect(state.stage).toBe("topics");
    expect(state.videos.map((v) => v.slot)).toEqual([1, 4]);
  });

  it("invalidates the chosen idea when the topic under it changes, and keeps it when it does not", () => {
    const base = run(...start, { type: "toggle-slot", slot: 0 }, { type: "confirm-count" }, { type: "set-topic", slot: 0, topic: "ai" }, { type: "set-idea", slot: 0, idea: IDEA, ideaTopic: "ai" });
    expect(base.videos[0].idea).toEqual(IDEA);

    expect(reduce(base, { type: "set-topic", slot: 0, topic: "tech" }).videos[0].idea).toBeNull();
    expect(reduce(base, { type: "set-topic", slot: 0, topic: "ai" }).videos[0].idea).toEqual(IDEA);
  });

  it("walks the whole path to review", () => {
    const state = run(
      ...start,
      { type: "toggle-slot", slot: 0 },
      { type: "confirm-count" },
      { type: "set-topic", slot: 0, topic: "ai" },
      { type: "confirm-topics" },
      { type: "set-idea", slot: 0, idea: IDEA, ideaTopic: "ai" },
      { type: "dispatched", traceId: "t1", note: null },
      { type: "forge-done" },
    );
    expect(state.stage).toBe("review");
    expect(state.traceId).toBe("t1");
  });

  it("reports progress exactly as it did before the fork existed", () => {
    const counted = run(...start, { type: "toggle-slot", slot: 0 }, { type: "confirm-count" });
    expect(furthestStage(run(...start))).toBe("count");
    expect(furthestStage(counted)).toBe("topics");
    expect(furthestStage(reduce(counted, { type: "set-topic", slot: 0, topic: "ai" }))).toBe("ideas");
    expect(furthestStage(run(...start, { type: "toggle-slot", slot: 0 }, { type: "confirm-count" }, { type: "dispatched", traceId: "t1", note: null }))).toBe("forge");
  });

  it("gates each stage on every video being specified, not just one", () => {
    const two = run(...start, { type: "toggle-slot", slot: 0 }, { type: "toggle-slot", slot: 1 }, { type: "confirm-count" }, { type: "set-topic", slot: 0, topic: "ai" });
    expect(topicsComplete(two)).toBe(false);
    expect(ideasComplete(two)).toBe(false);

    const both = reduce(two, { type: "set-topic", slot: 1, topic: "tech" });
    expect(topicsComplete(both)).toBe(true);
  });
});
