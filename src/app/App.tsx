/**
 * The operator surface — **two routes** since 2026-09-04 (operator direction).
 *
 * One client-rendered page. The landing is the hero and the passkey gate;
 * signing in moves the glass out to the edges, where it stays mounted for the
 * rest of the session (board 1: "the same 3D interactive glass shards now in
 * the edges"), and every stage after it runs inside that frame.
 *
 * Signing in now lands on a **fork**: two free-floating shards, "already have
 * an idea" and "brainstorm first". The first opens the chat route
 * (docs/CHAT_PIPELINE.md); the second opens the five stages this system has
 * always had, unchanged. They rejoin at `review`.
 *
 * The edge frame is mounted on every stage, the chat route's building screen
 * included. It was the one exception for four days, because that screen used
 * to gather those same fragments off the borders and set them orbiting the
 * orb — two sets of border glass, one of them departing, would have read as a
 * copy. The orbit was removed on 2026-09-05 (operator direction), so the
 * exception went with it and this screen has the same chrome as the rest.
 *
 * The lava-lamp spheres are mounted once, above everything's z-index
 * floor and below every surface — they never remount, so they keep
 * drifting across a stage change instead of jumping.
 */
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import "./glass/shards.css";
import { describeError, dispatchRun, getRunPlan, isUnauthorized, logout, submitRunPlan } from "./api.ts";
import { Spheres } from "./bg/Spheres.tsx";
import { EdgeFrame } from "./glass/EdgeFrame.tsx";
import type { SetKey } from "./glass/geometry.ts";
import { furthestStage, ideasComplete, initialState, reduce, topicsComplete, type Stage } from "./state.ts";
import { StageBuilding } from "./chat/StageBuilding.tsx";
import { StageCompose } from "./chat/StageCompose.tsx";
import { StageFork } from "./stages/StageFork.tsx";
import { Stage1Landing } from "./stages/Stage1Landing.tsx";
import { Stage2Count } from "./stages/Stage2Count.tsx";
import { Stage3Topics } from "./stages/Stage3Topics.tsx";
import { Stage4Ideas } from "./stages/Stage4Ideas.tsx";
import { Stage5Forge } from "./stages/Stage5Forge.tsx";
import { Stage6Review } from "./stages/Stage6Review.tsx";
import type { Topic } from "./types.ts";
import { TopBar } from "./ui/TopBar.tsx";

/** The atlas has a landscape and a portrait cut; which one the pane uses follows the viewport, exactly as the source component does. */
function useSetKey(): SetKey {
  const [portrait, setPortrait] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-aspect-ratio: 1/1)");
    const apply = (): void => setPortrait(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return portrait ? "mobile" : "desktop";
}

export default function App() {
  const [state, dispatch] = useReducer(reduce, initialState);
  const [signingOut, setSigningOut] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);
  const setKey = useSetKey();

  const onUnauthorized = useCallback(() => dispatch({ type: "signed-out" }), []);

  /**
   * The session cookie outlives the tab. Without this probe a reload put a
   * still-signed-in operator back on the landing page and asked them to
   * touch their authenticator again, for a session that was never lost —
   * the app just had no memory of it, because all of its state is
   * in-process.
   *
   * Any authenticated GET would do; the run plan is the cheapest (one
   * indexed read, no external call). A failure that is NOT a 401 leaves
   * the operator on the landing page deliberately: the honest thing when
   * the API is unreachable is to let them try to sign in, not to wave them
   * through into a surface whose every stage will then fail.
   */
  useEffect(() => {
    let cancelled = false;
    void getRunPlan().then((result) => {
      if (cancelled || !result.ok) return;
      dispatch({ type: "signed-in" });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const onSignOut = useCallback(async () => {
    setSigningOut(true);
    // The local state is cleared either way: if the call failed the cookie
    // may still be live, but leaving the operator looking at a signed-in
    // surface they can no longer use is the worse of the two.
    await logout();
    setSigningOut(false);
    dispatch({ type: "signed-out" });
  }, []);

  /**
   * Stage 4 → 5. Queue the plan, then dispatch. Both are writes, in that
   * order, and neither is retried: a retried queue would double-book the
   * signals and a retried dispatch would start two runs.
   */
  const deploy = useCallback(async () => {
    setDeploying(true);
    setDeployError(null);

    const picks = state.videos.flatMap((v) =>
      v.idea === null || v.ideaTopic === null ? [] : [{ topic: v.ideaTopic satisfies Topic, signalId: v.idea.signalId }],
    );

    const queued = await submitRunPlan(picks);
    if (!queued.ok) {
      setDeploying(false);
      if (isUnauthorized(queued.error)) {
        onUnauthorized();
        return;
      }
      setDeployError(`Could not queue the plan: ${describeError(queued.error)}`);
      return;
    }

    const started = await dispatchRun();
    setDeploying(false);
    if (!started.ok) {
      if (isUnauthorized(started.error)) {
        onUnauthorized();
        return;
      }
      // The plan IS queued at this point — saying so matters, because the
      // fix is to retry the dispatch, not to rebuild the plan.
      setDeployError(`The plan is queued, but the run could not be started: ${describeError(started.error)}`);
      return;
    }

    dispatch({ type: "dispatched", traceId: started.value.runId, note: started.value.note ?? null });
  }, [state.videos, onUnauthorized]);

  const furthest = useMemo(() => furthestStage(state), [state]);

  if (state.stage === "landing") {
    return (
      <>
        <Spheres />
        <Stage1Landing setKey={setKey} onSignedIn={() => dispatch({ type: "signed-in" })} />
      </>
    );
  }

  const stageView = ((stage: Stage) => {
    switch (stage) {
      case "fork":
        return <StageFork onChoose={(route) => dispatch({ type: "choose-route", route })} />;

      case "compose":
        return (
          <StageCompose
            onSubmitted={(brief, note, prompt) => dispatch({ type: "brief-submitted", briefId: brief.id, traceId: brief.traceId, prompt, note })}
            onUnauthorized={onUnauthorized}
          />
        );

      case "building":
        return state.briefId === null ? null : (
          <StageBuilding
            briefId={state.briefId}
            traceId={state.traceId}
            prompt={state.prompt ?? ""}
            dispatchNote={state.dispatchNote}
            onReview={() => dispatch({ type: "goto", stage: "review" })}
            onUnauthorized={onUnauthorized}
          />
        );

      case "count":
        return (
          <Stage2Count
            lit={state.lit}
            onToggle={(slot) => dispatch({ type: "toggle-slot", slot })}
            onConfirm={() => dispatch({ type: "confirm-count" })}
          />
        );
      case "topics":
        return (
          <Stage3Topics
            videos={state.videos}
            complete={topicsComplete(state)}
            onSetTopic={(slot, topic) => dispatch({ type: "set-topic", slot, topic })}
            onConfirm={() => dispatch({ type: "confirm-topics" })}
          />
        );
      case "ideas":
        return (
          <Stage4Ideas
            videos={state.videos}
            complete={ideasComplete(state)}
            busy={deploying}
            dispatchError={deployError}
            onSetIdea={(slot, idea, ideaTopic) => dispatch({ type: "set-idea", slot, idea, ideaTopic })}
            onConfirm={() => void deploy()}
            onUnauthorized={onUnauthorized}
          />
        );
      case "forge":
        return state.traceId === null ? null : (
          <Stage5Forge
            traceId={state.traceId}
            videos={state.videos}
            dispatchNote={state.dispatchNote}
            onDone={() => dispatch({ type: "forge-done" })}
            onUnauthorized={onUnauthorized}
          />
        );
      case "review":
        return <Stage6Review onRestart={() => dispatch({ type: "restart" })} onUnauthorized={onUnauthorized} />;
      case "landing":
        return null;
    }
  })(state.stage);

  return (
    <>
      <Spheres />
      <EdgeFrame setKey={setKey} />
      <TopBar
        current={state.stage}
        furthest={furthest}
        route={state.route}
        onGoto={(s) => dispatch({ type: "goto", stage: s })}
        onSignOut={() => void onSignOut()}
        signingOut={signingOut}
      />
      {/* Keyed on the stage so the resolve-in "image generation" fade
          (board 2) replays as each stage arrives. */}
      <div key={state.stage}>{stageView}</div>
    </>
  );
}
