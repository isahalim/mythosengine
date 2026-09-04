import { access } from "node:fs/promises";
import { TOOL_USE_FAILED_RECOVERED, type DriverError, type LlmDriver, type LlmMessage, type ToolDefinition } from "../drivers/types.ts";
import { EDIT_MODEL } from "../../config/models.ts";
import { QUOTAS } from "../../config/quotas.ts";
import { McpStdioClient } from "../drivers/mcp-stdio.ts";
import { ok, type Result } from "../result.ts";

/**
 * EDIT — a model driving Kinocut over MCP to find the moment in each sourced
 * clip that is actually worth showing, and cut to it (operator direction,
 * 2026-09-01; narrowed from "and grade it" to "and cut to it" on
 * 2026-09-04).
 *
 * **Where this sits, and what it is explicitly not.** It runs between
 * SOURCE and RENDER, and it edits clips *in place in the work directory* —
 * one clip in, one clip out, same slot in the montage. It does not stitch,
 * it does not composite the host, it does not burn captions and it does not
 * encode the final video. Those stay in `render-ffmpeg.ts`, which is the
 * path the operator has verified end to end, and putting a model-driven
 * tool loop on the critical path of the final encode would trade a working
 * pipeline for a more capable one that sometimes produces nothing.
 *
 * **It is allowed to fail, at every granularity.** A clip whose edit fails
 * keeps its original bytes and stays in the montage. A whole stage that
 * fails — Kinocut missing, `uvx` missing, the ladder exhausted — returns
 * every clip unedited. In both cases the render continues and produces
 * exactly the video it would have produced yesterday, and the reason is
 * recorded. That is the same contract RESEARCH and PLAN already have
 * (ARCHITECTURE.md §5.2.5), and it is the only contract under which adding
 * a stage to a working pipeline is a safe thing to do.
 *
 * **Why a curated tool subset, and why it is now three tools.** Kinocut
 * exposes 196 MCP tools. Their schemas serialize to well over a hundred
 * kilobytes, and a tool-calling loop re-sends every schema on every turn —
 * so offering all of them would spend a large share of the daily token
 * budget on the *menu*, before the model looked at a single frame. Nine
 * tools measured at ~2.1K tokens of menu on every one of ~34 turns in the
 * 2026-09-02 render; the operator cut the list to three on 2026-09-04, which
 * removes the six grading tools and roughly two thirds of that overhead.
 * What is left is exactly the sentence this stage is for: measure the clip,
 * find its scenes, cut to the best one.
 *
 * **What that gives up, said plainly.** Grading and stylising are gone from
 * this stage — no vignette, glow, chromatic aberration, scanlines, noise or
 * `video_filter`. Nothing else in the pipeline picks them up, so a clip is
 * composited with the colour it was sourced with. That is a deliberate
 * trade: the grade was one optional subtle call the prompt already told the
 * model to skip unless it suited the shot, and it was carried by six of the
 * nine schemas being re-sent on every turn of every clip.
 */

/**
 * The Kinocut tools EDIT may use, by their real MCP names (read from a live
 * `tools/list` against kinocut 1.15.1 on 2026-09-01, not guessed).
 *
 * Schemas are NOT hard-coded here — `listTools()` fetches them at run time
 * and this list only filters. A hand-copied schema is a schema that silently
 * drifts from the server on its next release, and the failure would be a
 * model confidently passing an argument that no longer exists.
 */
export const EDIT_TOOLS: readonly string[] = [
  // Measure first: duration and resolution, so a trim cannot run past the end.
  "video_info",
  // The actual "find key moments" tool — scene-change detection.
  "video_detect_scenes",
  // Cut to the moment worth showing. The last thing this stage does.
  "video_trim",
];

/**
 * How many tool calls one clip may spend.
 *
 * The work is three calls — probe, detect scenes, trim — so six leaves room
 * for a re-detect at a different threshold or a second trim that corrects a
 * window, and no more. Deliberately not cut to four alongside the tool list
 * on 2026-09-04: the ceiling is not what the stage normally spends, it is
 * what stops a model that has lost the thread, and a loop that ends early
 * because it ran out of turns leaves the clip as sourced.
 */
const MAX_TOOL_ITERATIONS = 6;

/**
 * Completion budget for one turn, and the number that has to stay under
 * `QUOTAS.groq.outputTokensPerMinuteQwen3`.
 *
 * The qwen3 models meter **output** tokens at 1,000 a minute, and a request
 * whose `max_tokens` exceeds that on its own is refused outright with an
 * HTTP 400 `invalid_request_error` — which is why this is derived from the
 * quota rather than written down, and why `max_tokens: 1024`, inherited from
 * the gpt-oss era, took both rungs of the ladder down on every turn of the
 * 2026-09-04 morning run.
 *
 * **Why 900 rather than the 750 that replaced it.** 750 was chosen as three
 * quarters of the ceiling to leave the minute some room, on the measurement
 * that a turn emits 33-208 output tokens. That measurement was taken on
 * `EDIT_MODEL`, which does not think out loud. `EDIT_FALLBACK_MODEL` does:
 * measured against the live API on 2026-09-04 it spends 122-173 tokens of
 * hidden reasoning *before* the visible answer on a first turn, and more
 * once a scene list is in the transcript. Reasoning is billed against the
 * same budget and arrives in a separate `reasoning` field, so a turn that
 * runs out of it comes back `finish_reason: "length"` with **empty
 * `content` and no tool call** — indistinguishable, from here, from a model
 * that simply declined to answer. That is exactly what the audit package
 * recorded for shots 0 and 1 of the 21:40 render: "the model finished
 * without naming a final file path", on a rung that had been cut off
 * mid-thought. Reproduced against the live API and the real Kinocut server
 * before this was changed.
 *
 * The budget alone is not the fix — `reasoningEffort: "none"` below is, and
 * it is what makes 900 comfortable rather than tight. This is the ceiling
 * for the case where a model ignores that hint, kept under the quota so the
 * request is always legal.
 */
const EDIT_MAX_TOKENS = Math.floor(QUOTAS.groq.outputTokensPerMinuteQwen3 * 0.9);

export interface EditableClip {
  /** Composited position, so a reported result maps back to the montage slot. */
  position: number;
  filePath: string;
  /** Seconds this clip is on screen — the edit must not make it shorter than this. */
  durationS: number;
  /** What this shot is doing in the argument, from PLAN. The model edits toward this. */
  intent: string;
  query: string;
  provider: "pexels" | "youtube";
}

interface EditedClip {
  position: number;
  /** The clip the encoder should use — the edited file, or the original when nothing changed. */
  filePath: string;
  /** Whether EDIT actually changed anything. */
  edited: boolean;
  /** Every Kinocut tool that ran for this clip, in order — the audit trail. */
  toolsRun: string[];
  /** Why this clip was left alone, when it was. Null when it was edited. */
  skippedReason: string | null;
}

export interface EditResult {
  clips: EditedClip[];
  /** Null when EDIT ran. Set when the whole stage was unavailable, in which case every clip is unedited. */
  degradedReason: string | null;
  /**
   * Which model actually drove the edit, for the audit package — every
   * distinct one that answered, comma-joined, in the order it first did.
   *
   * Normally one. Two when the EDIT ladder stepped down partway through the
   * clips, which is a thing a reviewer has to be able to see: "half this
   * video's clips were trimmed by the smaller model" is not recoverable from
   * the video. Null when no model answered at all.
   */
  model: string | null;
}

export interface EditDeps {
  llm: LlmDriver;
  workDir: string;
  /** How Kinocut is launched. Overridable so a test can point at a stub server. */
  command?: string;
  args?: string[];
  onEvent?: (event: string) => void;
  maxIterations?: number;
}

const DEFAULT_COMMAND = "uvx";
const DEFAULT_ARGS = ["--from", "kinocut", "kino", "--mcp"];

/**
 * The stage's standing instructions — everything true of every clip.
 *
 * Split out of the per-clip prompt on 2026-09-04 so this stage sends a
 * `system` turn *and* a `user` turn. That is not tidiness. The whole prompt
 * used to go out as a single `system` message with no user turn at all, and
 * the qwen3 models' chat template refuses that outright:
 *
 *     HTTP 400 "failed to template request: ... minijinja: rendering
 *     failed: raise_exception: No user query found in messages."
 *
 * with `type: "invalid_request_error"` — 0 tokens billed, 5ms, no retry,
 * and the ladder's second rung refused the identical shape a moment later.
 * gpt-oss tolerated a system-only conversation, so the arrangement worked
 * for as long as EDIT was on gpt-oss and broke silently the day the stage
 * moved. Which is the general lesson: a prompt shape is part of a model's
 * contract, and it does not travel across a model change for free.
 */
function editSystemPrompt(workDir: string): string {
  return `You are editing ONE background clip for a vertical short-form video.

The narrator is arguing over this footage. Your job is to find the most
watchable window of it that fills the clip's slot, and nothing more.

You have exactly three tools: video_info, video_detect_scenes and video_trim.
There are no others. Do not try to grade, colour, filter or stylise the clip —
this stage no longer does that, and a call to any other tool will be refused
and will cost you a turn.

Rules:
- Send every argument with exactly the JSON type the tool's schema declares.
  Kinocut types its timestamps as STRINGS: start: "18.86", duration: "7.20".
  A number there, or Python's True/False for a boolean, is rejected before
  the tool runs and costs you the turn.
- Write every output to a NEW file inside ${workDir}. Never overwrite an input.
- NEVER make the clip shorter than the length the brief asks for. A clip short
  of its slot leaves a gap in the finished video.
- Do not add text, subtitles, watermarks or audio. Those are handled elsewhere
  and would be duplicated.
- At most ${MAX_TOOL_ITERATIONS} tool calls. Doing nothing is a valid outcome:
  if the clip is already the right length and looks fine, say so and stop.

When you are finished, reply with the FINAL absolute file path on a line of
its own, in exactly this form and nothing else:

FINAL: /absolute/path/to/clip.mp4`;
}

/** The one clip's brief — the `user` turn every provider's chat template expects to find. */
function buildClipBrief(clip: EditableClip): string {
  const seconds = clip.durationS.toFixed(2);
  return `<clip>
  file: ${clip.filePath}
  source: ${clip.provider}
  found by searching: "${clip.query}"
  it must end up AT LEAST ${seconds} seconds long
  what this shot is doing in the argument: ${clip.intent}
</clip>

Find the most watchable ${seconds} seconds in this clip.

1. Call video_info to learn its real duration and resolution.
2. If it is comfortably longer than ${seconds}s, call video_detect_scenes and
   trim to the most visually interesting continuous window that is still at
   least ${seconds}s long. Prefer movement and a clear subject; avoid title
   cards, logos, letterboxed intros and near-static frames.

If you make no change at all, reply:

FINAL: ${clip.filePath}`;
}

/**
 * Pulls the path Kinocut says it wrote out of a tool result.
 *
 * Kinocut answers a render with `{"success": true, "output_path": "..."}`
 * (its own tool docs say so and the live server does it), and a tool that
 * rendered nothing — `video_info`, `video_detect_scenes` — carries no
 * `output_path` at all, so this reads as null for them without needing a
 * list of which tools produce files. A failed call is not read: the caller
 * only offers this a payload it knows succeeded.
 */
function readOutputPath(payload: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    // Not JSON. Kinocut's results are, so this is a build that answers in
    // prose; there is nothing to recover and the model's own FINAL line
    // remains the only route.
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as { success?: unknown; output_path?: unknown };
  if (record.success === false) return null;
  return typeof record.output_path === "string" && record.output_path.length > 0 ? record.output_path : null;
}

/** Pulls the model's declared output path out of its closing message. */
function readFinalPath(content: string): string | null {
  const match = /FINAL:\s*(\S+)/.exec(content);
  return match === null ? null : match[1].trim();
}

/**
 * Runs the edit loop for one clip.
 *
 * Returns the original clip on any failure — a clip that could not be
 * improved is still a clip, and the montage slot it fills is more valuable
 * than the improvement.
 */
async function editOne(clip: EditableClip, tools: ToolDefinition[], mcp: McpStdioClient, deps: EditDeps): Promise<{ clip: EditedClip; modelUsed: string | null }> {
  const onEvent = deps.onEvent ?? ((event: string) => console.warn(event));
  const maxIterations = deps.maxIterations ?? MAX_TOOL_ITERATIONS;
  const toolsRun: string[] = [];
  const allowed = new Set(tools.map((tool) => tool.name));
  /**
   * The last file Kinocut reported writing, straight off a tool result.
   *
   * The model is asked to close with `FINAL: <path>`, and when it does that
   * is the answer. This is what the stage falls back on when it does not:
   * `video_trim` returns `{"success": true, "output_path": ...}`, so a clip
   * that was actually cut has a real file on disk whether or not the turn
   * that would have named it survived. Throwing that away was costing
   * finished work — shot 0 of the 2026-09-04 21:40 render ran `video_trim`
   * twice and shipped as sourced — and it also covers the case observed live
   * against Kinocut the same day, where the model closed with a path it had
   * invented rather than the one the tool had just handed it.
   */
  let toolOutputPath: string | null = null;

  // The model that actually answered, which on the EDIT ladder is not
  // necessarily the one that was asked for: a failure on `EDIT_MODEL` moves
  // this clip and every clip after it to `EDIT_FALLBACK_MODEL`. Null until a
  // request has come back at all, so a clip skipped before any completion
  // does not claim a model spoke for it.
  let modelUsed: string | null = null;

  const unedited = (reason: string): { clip: EditedClip; modelUsed: string | null } => ({
    clip: { position: clip.position, filePath: clip.filePath, edited: false, toolsRun, skippedReason: reason },
    modelUsed,
  });

  /**
   * How every way of *not* getting a `FINAL:` line ends: with the cut
   * Kinocut has already made, if it made one, and otherwise as sourced.
   *
   * The model's own answer is still what this stage prefers — it is the one
   * that knows which of two trims it meant. This is the floor underneath it,
   * and it exists because the alternative is discarding a file that was
   * rendered, verified and sitting on disk over a formatting failure in the
   * sentence that was supposed to point at it.
   */
  const finish = async (reason: string): Promise<{ clip: EditedClip; modelUsed: string | null }> => {
    if (toolOutputPath === null || toolOutputPath === clip.filePath) return unedited(reason);
    try {
      await access(toolOutputPath);
    } catch {
      return unedited(reason);
    }
    onEvent(`EDIT: shot ${clip.position} — ${reason}; using the clip Kinocut reported writing instead (${toolOutputPath}).`);
    return { clip: { position: clip.position, filePath: toolOutputPath, edited: true, toolsRun, skippedReason: null }, modelUsed };
  };

  const messages: LlmMessage[] = [
    { role: "system", content: editSystemPrompt(deps.workDir) },
    // The `user` turn is required, not stylistic — see `editSystemPrompt`.
    { role: "user", content: buildClipBrief(clip) },
  ];

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const isLast = iteration === maxIterations - 1;
    if (isLast) {
      // Said out loud rather than enforced by withholding the tools — the
      // same lesson `researchSignal` learned the hard way: a provider that
      // validates the generation against the request rejects "the model
      // called a tool" when no tool was on offer.
      messages.push({ role: "user", content: `That is your last turn. Do not call another tool. Reply now with the FINAL: line only.` });
    }

    const completion = await deps.llm.complete({
      // The ladder overrides this; a plain driver honours it. Either way the
      // model that actually answered is read back off the response below.
      model: EDIT_MODEL,
      messages,
      tools,
      toolChoice: "auto",
      // Derived from the qwen3 output-per-minute ceiling, never a literal —
      // see `EDIT_MAX_TOKENS`. It is a ceiling rather than an allowance: a
      // turn emits one tool call or the line `FINAL: /path`, and what it
      // must never do is ask for more output than the meter allows in a
      // whole minute, which is refused before anything runs.
      maxTokens: EDIT_MAX_TOKENS,
      temperature: 0.3,
      // EDIT does not need a chain of thought and cannot afford one. The
      // work is "probe, detect, trim": every decision is read straight off a
      // tool result, and the two places judgement enters — which scene, and
      // whether the clip is already right — are one comparison each. What a
      // hidden reasoning trace costs is not abstract: it is billed against
      // `EDIT_MAX_TOKENS`, so on `EDIT_FALLBACK_MODEL` it truncated the
      // visible answer to nothing on the 2026-09-04 run, and it is billed
      // against the 1,000-output-tokens-a-minute meter, so it also decided
      // how many turns a minute this stage gets. Measured on both rungs that
      // day: 122-173 reasoning tokens on a first turn with it on, 0 with it
      // off, and the same tool call either way.
      reasoningEffort: "none",
    });
    if (!completion.ok) return unedited(`${completion.error.kind}: ${completion.error.message}`);
    modelUsed = completion.value.modelUsed ?? EDIT_MODEL;

    const call = completion.value.toolCalls?.[0];
    if (call === undefined) {
      const finalPath = readFinalPath(completion.value.content);
      if (finalPath === null) {
        // A turn that produced neither a tool call nor a `FINAL:` line has
        // wasted a turn, not ended the clip — so it costs a turn and the
        // loop says what was missing. Ending here was throwing away the
        // four turns still on the table, and there are at least three ways
        // to land in it that a second ask fixes: a `finish_reason: "length"`
        // truncation, a turn that narrates the plan without carrying it out,
        // and — watched live against Groq on 2026-09-04 — a tool call
        // rejected server-side for a schema violation
        // (`"accurate": expected boolean`), which arrives here as the prose
        // the model wrote before the call, the call itself gone.
        if (isLast) return finish("the model finished without naming a final file path");
        messages.push({ role: "assistant", content: completion.value.content });
        messages.push({
          role: "user",
          content:
            completion.value.finishReason === TOOL_USE_FAILED_RECOVERED
              ? // The provider itself refused the call, and it refused it for
                // a reason the model can act on. Measured on
                // `EDIT_FALLBACK_MODEL` against the live server on
                // 2026-09-04, twice in one clip: `/accurate: expected
                // boolean` (it sent Python's `False`) and `/duration:
                // expected string` (it sent the number 7.20). Left to the
                // generic nudge it re-sent the same shape and then gave up;
                // told what was wrong with it, it has something to fix.
                `Your last tool call was rejected before it ran: its arguments did not match the tool's schema. Read the schema again and re-send the call with exactly the JSON types it declares — a string argument needs quotes, a boolean must be true or false. Do not change your plan, only the argument types.`
              : `That turn called no tool and gave no FINAL: line. Either call one of the three tools, or reply with the FINAL: line naming the clip to use. Nothing else.`,
        });
        continue;
      }
      if (finalPath === clip.filePath) return unedited("the model judged the clip already right and changed nothing");

      // The model names a path; this checks it exists before the encoder is
      // told to read it. A hallucinated path would otherwise fail the whole
      // render at encode time, long after the stage that invented it — and
      // a model naming a plausible path over the one `video_trim` handed it
      // is not hypothetical, it was watched happening against the live
      // server on 2026-09-04.
      try {
        await access(finalPath);
      } catch {
        return finish(`the model named an output file that does not exist: ${finalPath}`);
      }
      return { clip: { position: clip.position, filePath: finalPath, edited: true, toolsRun, skippedReason: null }, modelUsed };
    }

    if (isLast) return finish(`the model kept calling tools through all ${maxIterations} turns without producing a clip`);

    messages.push({
      role: "assistant",
      content: completion.value.content,
      toolCalls: [call],
    });

    // The allowlist is enforced here, not merely by what was offered. A
    // model that names a tool outside the shortlist is answered with a
    // refusal rather than a call — Kinocut exposes 196 tools and this stage
    // is not entitled to all of them.
    if (!allowed.has(call.name)) {
      messages.push({ role: "tool", content: JSON.stringify({ error: `"${call.name}" is not available in this stage. Available: ${[...allowed].join(", ")}` }), toolCallId: call.id });
      continue;
    }

    let args: unknown;
    try {
      args = JSON.parse(call.argumentsJson);
    } catch {
      args = {};
    }

    toolsRun.push(call.name);
    const result = await mcp.callTool(call.name, args);
    const payload = result.ok ? result.value.text : JSON.stringify({ error: `${result.error.kind}: ${result.error.message}` });
    if (result.ok) toolOutputPath = readOutputPath(payload) ?? toolOutputPath;
    messages.push({ role: "tool", content: payload, toolCallId: call.id });
    if (!result.ok) onEvent(`EDIT: ${call.name} failed for shot ${clip.position} — ${result.error.message}`);
  }

  return finish(`no final clip after ${maxIterations} turns`);
}

/**
 * Runs EDIT over a render's clips.
 *
 * Never returns an error. The worst outcome is every clip unedited with a
 * reason attached, which is exactly the video the pipeline made before this
 * stage existed.
 */
export async function editClips(clips: EditableClip[], deps: EditDeps): Promise<Result<EditResult, DriverError>> {
  const onEvent = deps.onEvent ?? ((event: string) => console.warn(event));
  const unedited = (reason: string): Result<EditResult, DriverError> =>
    ok({
      clips: clips.map((clip) => ({ position: clip.position, filePath: clip.filePath, edited: false, toolsRun: [], skippedReason: reason })),
      degradedReason: reason,
      model: null,
    });

  if (clips.length === 0) return ok({ clips: [], degradedReason: null, model: null });

  const mcp = new McpStdioClient({
    command: deps.command ?? DEFAULT_COMMAND,
    args: deps.args ?? DEFAULT_ARGS,
    cwd: deps.workDir,
  });

  const started = await mcp.start();
  if (!started.ok) {
    mcp.close();
    return unedited(`Kinocut MCP server would not start (${started.error.message}) — every clip used unedited`);
  }

  try {
    const listed = await mcp.listTools();
    if (!listed.ok) return unedited(`Kinocut MCP server would not list its tools (${listed.error.message}) — every clip used unedited`);

    // Filtered to the shortlist, with schemas as the server reports them.
    const tools = listed.value.filter((tool) => EDIT_TOOLS.includes(tool.name));
    const missing = EDIT_TOOLS.filter((name) => !tools.some((tool) => tool.name === name));
    if (missing.length > 0) onEvent(`EDIT: this Kinocut build does not expose ${missing.join(", ")} — continuing with ${tools.length} tool(s).`);
    if (tools.length === 0) return unedited("this Kinocut build exposes none of the tools EDIT uses — every clip used unedited");

    const edited: EditedClip[] = [];
    // Every distinct model that answered, in the order it first did. Normally
    // one; two when the ladder stepped down partway through the clips, and
    // the audit package has to say so rather than name only the model the
    // stage started on.
    const modelsUsed: string[] = [];
    for (const clip of clips) {
      const { clip: result, modelUsed } = await editOne(clip, tools, mcp, deps);
      edited.push(result);
      if (modelUsed !== null && !modelsUsed.includes(modelUsed)) modelsUsed.push(modelUsed);
      onEvent(
        result.edited
          ? `EDIT: shot ${clip.position} edited via ${result.toolsRun.join(" -> ") || "no tools"}.`
          : `EDIT: shot ${clip.position} left as sourced — ${result.skippedReason ?? "no reason given"}.`,
      );
    }
    const model = modelsUsed.length === 0 ? null : modelsUsed.join(", ");

    return ok({ clips: edited, degradedReason: null, model });
  } finally {
    mcp.close();
  }
}
