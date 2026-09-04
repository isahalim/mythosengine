import { access } from "node:fs/promises";
import type { DriverError, LlmDriver, LlmMessage, ToolDefinition } from "../drivers/types.ts";
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
 * The qwen3 models meter **output** tokens per minute at 1,000, and that
 * ceiling applies per request as well as per minute: a request whose
 * expected output exceeds it is refused with an HTTP 400
 * `invalid_request_error` in about five milliseconds, having billed nothing
 * and run nothing. `max_tokens: 1024` — inherited from the gpt-oss era, when
 * this stage was on a model with no such ceiling — was therefore *one token
 * over a hard wall*, and it took both rungs of the EDIT ladder down on every
 * single turn of the 2026-09-04 run. The stage did exactly what it is built
 * to do (every clip as sourced, render exported) and that is the only reason
 * it was a Groq dashboard line rather than a page.
 *
 * 768 is three quarters of the ceiling, not the whole of it, because the
 * limit is a *leaky bucket* as well as a per-request wall: a request
 * reserves its `max_tokens` on admission and reconciles to the real figure
 * afterwards, so sitting at 1,000 would mean the first turn of every minute
 * consumed the entire allowance. Measured against both rungs with the real
 * three-tool menu on 2026-09-04, a turn emits 33-208 output tokens — a tool
 * call and its reasoning — so this is roughly four times the worst observed
 * turn and was never the binding constraint on what the model could say.
 */
const EDIT_MAX_TOKENS = Math.floor(QUOTAS.groq.outputTokensPerMinuteQwen3 * 0.75);

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
      // see `EDIT_MAX_TOKENS`. A turn here emits either one tool call or the
      // line `FINAL: /path`, so a larger budget was never spent, but it was
      // *reserved* twice over: by Groq's OTPM meter, which refuses the whole
      // request above 1,000, and by our own limiter, which paces on
      // `maxTokens + prompt` against 8K input tokens a minute.
      maxTokens: EDIT_MAX_TOKENS,
      temperature: 0.3,
    });
    if (!completion.ok) return unedited(`${completion.error.kind}: ${completion.error.message}`);
    modelUsed = completion.value.modelUsed ?? EDIT_MODEL;

    const call = completion.value.toolCalls?.[0];
    if (call === undefined) {
      const finalPath = readFinalPath(completion.value.content);
      if (finalPath === null) return unedited("the model finished without naming a final file path");
      if (finalPath === clip.filePath) return unedited("the model judged the clip already right and changed nothing");

      // The model names a path; this checks it exists before the encoder is
      // told to read it. A hallucinated path would otherwise fail the whole
      // render at encode time, long after the stage that invented it.
      try {
        await access(finalPath);
      } catch {
        return unedited(`the model named an output file that does not exist: ${finalPath}`);
      }
      return { clip: { position: clip.position, filePath: finalPath, edited: true, toolsRun, skippedReason: null }, modelUsed };
    }

    if (isLast) return unedited(`the model kept calling tools through all ${maxIterations} turns without producing a clip`);

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
    messages.push({ role: "tool", content: payload, toolCallId: call.id });
    if (!result.ok) onEvent(`EDIT: ${call.name} failed for shot ${clip.position} — ${result.error.message}`);
  }

  return unedited(`no final clip after ${maxIterations} turns`);
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
