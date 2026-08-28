import { describe, expect, it } from "vitest";
import {
  assertRenderTransition,
  assertScriptTransition,
  assertSignalTransition,
  assertUploadTransition,
  IllegalTransitionError,
} from "./state.ts";

describe("signal state machine", () => {
  it("allows the documented happy path", () => {
    expect(() => assertSignalTransition("observed", "scored")).not.toThrow();
    expect(() => assertSignalTransition("scored", "scripted")).not.toThrow();
    expect(() => assertSignalTransition("scripted", "critiqued")).not.toThrow();
    expect(() => assertSignalTransition("critiqued", "gated")).not.toThrow();
    expect(() => assertSignalTransition("gated", "uploaded")).not.toThrow();
  });

  it("allows dropping to rejected/failed from any non-terminal state", () => {
    expect(() => assertSignalTransition("observed", "rejected")).not.toThrow();
    expect(() => assertSignalTransition("critiqued", "failed")).not.toThrow();
  });

  it("rejects skipping a stage", () => {
    expect(() => assertSignalTransition("observed", "critiqued")).toThrow(IllegalTransitionError);
  });

  it("rejects any transition out of a terminal state", () => {
    expect(() => assertSignalTransition("uploaded", "scored")).toThrow(IllegalTransitionError);
    expect(() => assertSignalTransition("rejected", "observed")).toThrow(IllegalTransitionError);
  });

  it("rejects moving backward", () => {
    expect(() => assertSignalTransition("scripted", "scored")).toThrow(IllegalTransitionError);
  });
});

describe("script/render/upload state machines", () => {
  it("script: draft -> approved is legal, approved -> draft is not", () => {
    expect(() => assertScriptTransition("draft", "approved")).not.toThrow();
    expect(() => assertScriptTransition("approved", "draft")).toThrow(IllegalTransitionError);
  });

  it("render: pending -> rendered is legal, rendered -> pending is not", () => {
    expect(() => assertRenderTransition("pending", "rendered")).not.toThrow();
    expect(() => assertRenderTransition("rendered", "pending")).toThrow(IllegalTransitionError);
  });

  it("upload: full happy path, and no skipping straight to published", () => {
    expect(() => assertUploadTransition("pending_approval", "approved")).not.toThrow();
    expect(() => assertUploadTransition("approved", "published")).not.toThrow();
    expect(() => assertUploadTransition("pending_approval", "published")).toThrow(IllegalTransitionError);
  });
});
