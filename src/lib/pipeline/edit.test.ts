import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EDIT_TOOLS, editClips, type EditableClip } from "./edit.ts";
import { EDIT_MODEL } from "../../config/models.ts";
import { QUOTAS } from "../../config/quotas.ts";
import type { DriverError, LlmDriver, LlmRequest, ToolDefinition } from "../drivers/types.ts";
import { err, ok } from "../result.ts";

const server = join(import.meta.dirname, "..", "drivers", "__fixtures__", "fake-mcp-server.mjs");

let workDir: string;
let editedPath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "edit-test-"));
  editedPath = join(workDir, "edited-0.mp4");
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function clip(overrides: Partial<EditableClip> = {}): EditableClip {
  return {
    position: 0,
    filePath: "/tmp/sourced-0.mp4",
    durationS: 4,
    intent: "the claim looks obvious here",
    query: "empty courtroom gallery",
    provider: "pexels",
    ...overrides,
  };
}

/** An LLM that plays a fixed script of turns: a tool call, or a final text answer. */
function scripted(turns: ({ tool: string; args?: unknown } | { text: string })[]): { llm: LlmDriver; offered: ToolDefinition[][] } {
  const offered: ToolDefinition[][] = [];
  let i = 0;
  return {
    offered,
    llm: {
      complete(req: LlmRequest) {
        offered.push(req.tools ?? []);
        const turn = turns[Math.min(i++, turns.length - 1)];
        if ("text" in turn) {
          return Promise.resolve(ok({ content: turn.text, finishReason: "completed", quotaRemaining: null, tokensUsed: 1 }));
        }
        return Promise.resolve(
          ok({
            content: "",
            finishReason: "requires_action",
            toolCalls: [{ id: `call_${i}`, name: turn.tool, argumentsJson: JSON.stringify(turn.args ?? {}) }],
            quotaRemaining: null,
            tokensUsed: 1,
          }),
        );
      },
    },
  };
}

/** Wraps a driver and keeps every request it was handed, for assertions about the wire shape. */
function spying(inner: LlmDriver): { llm: LlmDriver; requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  return {
    requests,
    llm: {
      complete: (req) => {
        requests.push(req);
        return inner.complete(req);
      },
    },
  };
}

const deps = (llm: LlmDriver, extra: Record<string, unknown> = {}) => ({
  llm,
  workDir,
  command: process.execPath,
  args: [server],
  onEvent: () => {},
  ...extra,
});

describe("editClips", () => {
  // Same reason as rerank's: EDIT names its own model, and a wrong one
  // fails soft to "every clip as sourced" — a degradation that looks
  // exactly like Kinocut being unavailable and is easy to misread as one.
  // Since 2026-09-04 that model is EDIT's own, not the general reasoning
  // one: a plain driver is asked for `EDIT_MODEL`, and the ladder RENDER
  // hands it overrides that with the same id and then qwen3.6-27b beneath.
  it("asks the reasoning model the pipeline actually runs on", async () => {
    writeFileSync(editedPath, "video");
    const asked: string[] = [];
    const inner = scripted([{ text: `FINAL: ${editedPath}` }]).llm;
    const llm: LlmDriver = {
      complete: (req) => {
        asked.push(req.model);
        return inner.complete(req);
      },
    };
    await editClips([clip()], deps(llm));
    expect(asked).toEqual([EDIT_MODEL]);
  });

  it("returns the edited file when the model produces one", async () => {
    writeFileSync(editedPath, "video");
    const { llm } = scripted([{ tool: "video_info", args: { input_path: "/tmp/sourced-0.mp4" } }, { text: `FINAL: ${editedPath}` }]);

    const result = await editClips([clip()], deps(llm));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.clips[0]).toMatchObject({ position: 0, filePath: editedPath, edited: true, skippedReason: null });
    expect(result.value.clips[0].toolsRun).toEqual(["video_info"]);
    expect(result.value.degradedReason).toBeNull();
  });

  it("offers only the curated shortlist, never all 196 of Kinocut's tools", async () => {
    // Every schema is re-sent on every turn, so offering the whole surface
    // would spend a large share of the daily budget on the menu alone.
    const { llm, offered } = scripted([{ text: `FINAL: /tmp/sourced-0.mp4` }]);
    await editClips([clip()], deps(llm));

    const names = offered[0].map((t) => t.name);
    expect(names.sort()).toEqual([...EDIT_TOOLS].sort());
    expect(names).not.toContain("video_publish_gate");
    expect(names).not.toContain("hyperframes_render");
  });

  // Spelled out rather than left to `EDIT_TOOLS`, because the list is the
  // operator's instruction of 2026-09-04 and not an implementation detail:
  // three tools, and the six grading tools gone. A tenth tool added back
  // costs every turn of every clip its schema, and nothing else would notice.
  it("offers exactly three tools — measure, detect scenes, trim", () => {
    expect([...EDIT_TOOLS]).toEqual(["video_info", "video_detect_scenes", "video_trim"]);
  });

  // "Fallback and continue with the rest of the work." The ladder is sticky,
  // so the second clip is already on the second model — and the audit
  // package has to name both rather than only the one the stage started on.
  it("records every model that answered when the ladder steps down mid-run", async () => {
    writeFileSync(editedPath, "video");
    let turn = 0;
    const llm: LlmDriver = {
      complete: () => {
        turn += 1;
        // The ladder's own rung is what a real EDIT sees here; this stands
        // in for one by reporting a different model than it was asked for.
        return Promise.resolve(
          ok({ content: `FINAL: ${editedPath}`, finishReason: "completed", quotaRemaining: null, tokensUsed: 1, modelUsed: turn === 1 ? EDIT_MODEL : "qwen/qwen3.6-27b" }),
        );
      },
    };

    const result = await editClips([clip(), clip({ position: 1 })], deps(llm));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.model).toBe(`${EDIT_MODEL}, qwen/qwen3.6-27b`);
  });

  it("keeps the sourced clip when the model decides nothing needs changing", async () => {
    const { llm } = scripted([{ text: "FINAL: /tmp/sourced-0.mp4" }]);
    const result = await editClips([clip()], deps(llm));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.clips[0].edited).toBe(false);
    expect(result.value.clips[0].skippedReason).toContain("changed nothing");
  });

  it("refuses a tool outside the shortlist instead of calling it", async () => {
    const { llm } = scripted([{ tool: "hyperframes_render" }, { text: "FINAL: /tmp/sourced-0.mp4" }]);
    const result = await editClips([clip()], deps(llm));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The refusal is fed back as a tool result, so the model can correct
    // itself — but the call never reaches the server.
    expect(result.value.clips[0].toolsRun).toEqual([]);
  });

  it("keeps the sourced clip when the model names an output that does not exist", async () => {
    // A hallucinated path would otherwise fail the whole render at encode
    // time, long after the stage that invented it.
    const { llm } = scripted([{ text: `FINAL: ${join(workDir, "never-written.mp4")}` }]);
    const result = await editClips([clip()], deps(llm));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.clips[0].filePath).toBe("/tmp/sourced-0.mp4");
    expect(result.value.clips[0].skippedReason).toContain("does not exist");
  });

  it("keeps the sourced clip when the model never names a final path", async () => {
    const { llm } = scripted([{ text: "I have finished editing the clip." }]);
    const result = await editClips([clip()], deps(llm));
    expect(result.ok && result.value.clips[0].edited).toBe(false);
  });

  it("keeps the sourced clip when the model loops on tools without finishing", async () => {
    const { llm } = scripted([{ tool: "video_info" }]);
    const result = await editClips([clip()], deps(llm, { maxIterations: 3 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.clips[0].edited).toBe(false);
    expect(result.value.clips[0].skippedReason).toContain("without producing a clip");
  });

  it("keeps the sourced clip when the model call itself fails", async () => {
    const llm: LlmDriver = { complete: () => Promise.resolve(err({ kind: "rate_limited", message: "429", retryable: true } as DriverError)) };
    const result = await editClips([clip()], deps(llm));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.clips[0].edited).toBe(false);
    expect(result.value.clips[0].skippedReason).toContain("rate_limited");
  });

  it("feeds a failed tool call back to the model rather than abandoning the clip", async () => {
    writeFileSync(editedPath, "video");
    const { llm } = scripted([{ tool: "video_trim", args: { input_path: "/tmp/sourced-0.mp4" } }, { text: `FINAL: ${editedPath}` }]);
    // In this mode video_trim answers `isError: true` — a tool that ran and
    // failed, which the model can often fix and retry.
    const result = await editClips([clip()], deps(llm, { args: [server, "tool-error"] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.clips[0].toolsRun).toEqual(["video_trim"]);
    expect(result.value.clips[0].edited).toBe(true);
  });

  it("returns every clip unedited when the MCP server cannot start", async () => {
    // The whole-stage fail-soft: a missing Kinocut costs the render its
    // grade, never its video.
    const { llm } = scripted([{ text: "FINAL: /tmp/sourced-0.mp4" }]);
    const result = await editClips([clip(), clip({ position: 1, filePath: "/tmp/sourced-1.mp4" })], deps(llm, { command: "definitely-not-a-real-binary-xyz" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.clips).toHaveLength(2);
    expect(result.value.clips.every((c) => !c.edited)).toBe(true);
    expect(result.value.clips.map((c) => c.filePath)).toEqual(["/tmp/sourced-0.mp4", "/tmp/sourced-1.mp4"]);
    expect(result.value.degradedReason).toContain("would not start");
  });

  it("returns every clip unedited when the server exposes none of EDIT's tools", async () => {
    const { llm } = scripted([{ text: "FINAL: /tmp/sourced-0.mp4" }]);
    const result = await editClips([clip()], deps(llm, { args: [server, "bad-list"] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.degradedReason).not.toBeNull();
    expect(result.value.clips[0].edited).toBe(false);
  });

  it("does nothing at all for an empty montage", async () => {
    const { llm } = scripted([{ text: "unused" }]);
    const result = await editClips([], deps(llm));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.clips).toEqual([]);
    expect(result.value.degradedReason).toBeNull();
  });

  it("tells the model the minimum length, so an edit cannot leave a gap in the video", async () => {
    const { llm, requests } = spying(scripted([{ text: "FINAL: /tmp/sourced-0.mp4" }]).llm);

    await editClips([clip({ durationS: 7.25 })], deps(llm));

    const prompt = requests[0].messages.map((message) => message.content).join("\n");
    expect(prompt).toContain("7.25");
    expect(prompt).toContain("the claim looks obvious here");
  });

  /**
   * Both halves of the 2026-09-04 EDIT outage, pinned.
   *
   * The stage had been sending a single `system` message and asking for
   * `max_tokens: 1024`. Neither was visible in any test, because a stub
   * driver accepts any shape and has no rate limit — and both are refused
   * outright by the qwen3 models the stage moved to that morning:
   *
   *   400 invalid_request_error "No user query found in messages."
   *   400 invalid_request_error "... output tokens per minute (OTPM):
   *       Limit 1000, Requested 1024"
   *
   * Every turn of every clip, on both rungs, in about five milliseconds. The
   * render still exported — that contract held — but it exported with every
   * clip as sourced.
   */
  it("sends a user turn and stays under the qwen3 output ceiling", async () => {
    const { llm, requests } = spying(scripted([{ text: "FINAL: /tmp/sourced-0.mp4" }]).llm);

    await editClips([clip()], deps(llm));

    // A system-only conversation is what qwen3's chat template refuses.
    expect(requests[0].messages.map((message) => message.role)).toEqual(["system", "user"]);
    // And the per-request output ceiling is a wall, not a pace: a request
    // above it is rejected before it runs, so the limiter cannot save it.
    expect(requests[0].maxTokens).toBeLessThan(QUOTAS.groq.outputTokensPerMinuteQwen3);
  });
});
