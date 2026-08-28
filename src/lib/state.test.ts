import { describe, expect, it } from "vitest";
import {
  assertExportTransition,
  assertRenderTransition,
  assertScriptTransition,
  assertSignalTransition,
  IllegalTransitionError,
} from "./state.ts";

describe("signal state machine", () => {
  it("allows the documented happy path", () => {
    expect(() => assertSignalTransition("observed", "scored")).not.toThrow();
    expect(() => assertSignalTransition("scored", "scripted")).not.toThrow();
    expect(() => assertSignalTransition("scripted", "critiqued")).not.toThrow();
    expect(() => assertSignalTransition("critiqued", "exported")).not.toThrow();
  });

  it("allows dropping to rejected/failed from any non-terminal state", () => {
    expect(() => assertSignalTransition("observed", "rejected")).not.toThrow();
    expect(() => assertSignalTransition("critiqued", "failed")).not.toThrow();
  });

  it("rejects skipping a stage", () => {
    expect(() => assertSignalTransition("observed", "critiqued")).toThrow(IllegalTransitionError);
  });

  it("rejects any transition out of a terminal state", () => {
    expect(() => assertSignalTransition("exported", "scored")).toThrow(IllegalTransitionError);
    expect(() => assertSignalTransition("rejected", "observed")).toThrow(IllegalTransitionError);
  });

  it("rejects moving backward", () => {
    expect(() => assertSignalTransition("scripted", "scored")).toThrow(IllegalTransitionError);
  });
});

describe("script/render/export state machines", () => {
  it("script: draft -> approved is legal, approved -> draft is not", () => {
    expect(() => assertScriptTransition("draft", "approved")).not.toThrow();
    expect(() => assertScriptTransition("approved", "draft")).toThrow(IllegalTransitionError);
  });

  it("render: pending -> rendered is legal, rendered -> pending is not", () => {
    expect(() => assertRenderTransition("pending", "rendered")).not.toThrow();
    expect(() => assertRenderTransition("rendered", "pending")).toThrow(IllegalTransitionError);
  });

  it("export: full happy path, and no skipping straight to reviewed", () => {
    expect(() => assertExportTransition("ready_for_review", "downloaded")).not.toThrow();
    expect(() => assertExportTransition("downloaded", "reviewed")).not.toThrow();
    expect(() => assertExportTransition("ready_for_review", "reviewed")).toThrow(IllegalTransitionError);
  });

  it("export: ready_for_review can also be discarded or expire directly, without a download", () => {
    expect(() => assertExportTransition("ready_for_review", "discarded")).not.toThrow();
    expect(() => assertExportTransition("ready_for_review", "expired")).not.toThrow();
  });
});
