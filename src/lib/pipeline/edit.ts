import { access } from "node:fs/promises";
import type { DriverError, LlmDriver, LlmMessage, ToolDefinition } from "../drivers/types.ts";
import { GROQ_REASONING_MODEL } from "../../config/models.ts";
import { McpStdioClient } from "../drivers/mcp-stdio.ts";
import { ok, type Result } from "../result.ts";

/**
 * EDIT — Gemini driving Kinocut over MCP to find the moment in each sourced
 * clip that is actually worth showing, and to grade it (operator direction,
 * 2026-09-01).
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
 * **Why a curated tool subset.** Kinocut exposes 196 MCP tools. Their
 * schemas serialize to well over a hundred kilobytes, and a tool-calling
 * loop re-sends every schema on every turn — so offering all of them would
 * spend a large share of a 250K-token daily budget on the *menu*, before
 * the model looked at a single frame. `EDIT_TOOLS` is the shortlist that
 * matches what this stage is for: measure the clip, find its scenes, cut to
 * the best one, and grade it.
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
  // Cut to the moment worth showing.
  "video_trim",
  // Grade and stylise.
  "video_filter",
  "effect_vignette",
  "effect_glow",
  "effect_chromatic_aberration",
  "effect_scanlines",
  "effect_noise",
];

/** How many tool calls one clip may spend. Six is enough to probe, detect scenes, trim and apply two effects; more is a model that has lost the thread. */
const MAX_TOOL_ITERATIONS = 6;

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
  /** Which model actually drove the edit, for the audit package. */
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

function buildPrompt(clip: EditableClip, workDir: string): string {
  return `You are editing ONE background clip for a vertical short-form video.

<clip>
  file: ${clip.filePath}
  source: ${clip.provider}
  found by searching: "${clip.query}"
  it must end up AT LEAST ${clip.durationS.toFixed(2)} seconds long
  what this shot is doing in the argument: ${clip.intent}
</clip>

The narrator is arguing over this footage. Your job is to make this clip the
most watchable ${clip.durationS.toFixed(2)} seconds it can be, and nothing more.

Do this:
1. Call video_info to learn the clip's real duration and resolution.
2. If it is comfortably longer than ${clip.durationS.toFixed(2)}s, call
   video_detect_scenes and trim to the most visually interesting continuous
   window that is still at least ${clip.durationS.toFixed(2)}s long. Prefer
   movement and a clear subject; avoid title cards, logos, letterboxed
   intros and near-static frames.
3. Optionally apply ONE subtle grade or effect if it genuinely suits the
   shot's intent above. Subtle. This is a background behind burned-in
   captions and an animated host, so anything strong makes the text
   unreadable and the host hard to see.

Rules:
- Write every output to a NEW file inside ${workDir}. Never overwrite an input.
- NEVER make the clip shorter than ${clip.durationS.toFixed(2)} seconds. A clip
  short of its slot leaves a gap in the finished video.
- Do not add text, subtitles, watermarks or audio. Those are handled elsewhere
  and would be duplicated.
- At most ${MAX_TOOL_ITERATIONS} tool calls. Doing nothing is a valid outcome:
  if the clip is already the right length and looks fine, say so and stop.

When you are finished, reply with the FINAL absolute file path on a line of
its own, in exactly this form and nothing else:

FINAL: /absolute/path/to/clip.mp4

If you made no change at all, reply:

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
async function editOne(clip: EditableClip, tools: ToolDefinition[], mcp: McpStdioClient, deps: EditDeps): Promise<EditedClip> {
  const onEvent = deps.onEvent ?? ((event: string) => console.warn(event));
  const maxIterations = deps.maxIterations ?? MAX_TOOL_ITERATIONS;
  const toolsRun: string[] = [];
  const allowed = new Set(tools.map((tool) => tool.name));

  const unedited = (reason: string): EditedClip => ({ position: clip.position, filePath: clip.filePath, edited: false, toolsRun, skippedReason: reason });

  const messages: LlmMessage[] = [{ role: "system", content: buildPrompt(clip, deps.workDir) }];

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
      model: GROQ_REASONING_MODEL,
      messages,
      tools,
      toolChoice: "auto",
      maxTokens: 2048,
      temperature: 0.3,
    });
    if (!completion.ok) return unedited(`${completion.error.kind}: ${completion.error.message}`);

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
      return { position: clip.position, filePath: finalPath, edited: true, toolsRun, skippedReason: null };
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
    let model: string | null = null;
    for (const clip of clips) {
      const result = await editOne(clip, tools, mcp, deps);
      edited.push(result);
      model ??= GROQ_REASONING_MODEL;
      onEvent(
        result.edited
          ? `EDIT: shot ${clip.position} edited via ${result.toolsRun.join(" -> ") || "no tools"}.`
          : `EDIT: shot ${clip.position} left as sourced — ${result.skippedReason ?? "no reason given"}.`,
      );
    }

    return ok({ clips: edited, degradedReason: null, model });
  } finally {
    mcp.close();
  }
}
