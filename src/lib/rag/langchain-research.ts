import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { err, ok, type Result } from "../result.ts";
import type { DriverError } from "../drivers/types.ts";
import {
  GEMINI_REASONING_MODEL,
  GEMINI_RESEARCH_FALLBACK_ITERATIONS,
  GEMINI_RESEARCH_MAX_ITERATIONS,
  GEMINI_RESEARCH_MODEL,
} from "../../config/models.ts";
import { GEMINI_RESEARCH_TIMEOUT_MS } from "../drivers/resolve-gemini-driver.ts";
import type { ResearchBrief, ResearchCitation } from "./research.ts";

/**
 * RESEARCH for the chat route — LangChain over Gemini with **Google Search
 * grounding** (operator direction, 2026-09-04).
 *
 * *Why this stage is different from the brainstorm route's.* The BM25 path
 * in `research.ts` exists because a brainstorm-route idea IS a row in the
 * `signals` corpus: the story was ingested by WATCH, so retrieving it is a
 * lookup and `read_source` can be confined to what was retrieved. A chat
 * brief has no such anchor. The operator typed a sentence about something
 * that may have happened an hour ago and may never appear in any feed this
 * system polls, so retrieval over the corpus would return either nothing or
 * something adjacent — and a script grounded in something adjacent is worse
 * than an honest ungrounded one.
 *
 * *Why grounding rather than a search API.* This was the operator's call on
 * 2026-09-04, against a scraped-SERP driver and against adding Tavily or
 * Brave. It adds no credential, no fourth metered provider, and no page
 * markup to be broken by — `GEMINI_API_KEY` already exists and the search
 * tool is the provider's own.
 *
 * *Four turns, then a second model that continues* (operator direction,
 * 2026-09-05: "use gemini-3.8-flash max call 4 times and if necessary
 * fallback on gemini-3.5-flash-lite by continuing from the leftover work").
 * Until then this was a single `invoke`, and the "four turns" it advertised
 * lived only in the prompt's own text — a reply that came back without JSON,
 * or with claims none of which were traceable to a page search returned,
 * ended the stage there and the brief went `ungrounded`. Now:
 *
 *   1. Up to `GEMINI_RESEARCH_MAX_ITERATIONS` invocations of
 *      `GEMINI_RESEARCH_MODEL`. A turn that returns a usable brief ends the
 *      stage; a turn that does not is told what was missing and gets
 *      another, with everything found so far still in the conversation.
 *   2. If those run out — or the model errors, times out or is rate-limited
 *      partway through — up to `GEMINI_RESEARCH_FALLBACK_ITERATIONS`
 *      invocations of `GEMINI_REASONING_MODEL`, opened with the **leftover
 *      work**: every page the first model's searches actually returned, and
 *      its own last draft.
 *
 * *Why carrying work across the two models is allowed here, when
 * `research-provider.ts` forbids exactly that.* The rule there is about
 * splicing a second Gemini model into a live tool conversation, where it
 * inherits the first's signed `thought` steps — untested, and a failure that
 * only shows up in production. There is no client-side tool loop on this
 * path: the search is the provider's own and runs server-side, and what
 * crosses to the fallback is a plain-text list of URLs and titles plus the
 * first model's prose. Nothing signed, nothing replayed, and a different
 * model id means a different 5-requests-per-minute bucket.
 *
 * *What it does NOT change.* The failure contract is the brainstorm route's,
 * unchanged and deliberately so:
 *
 * - **It cannot fail a render.** Any failure — no key, a 500, a 429, a
 *   timeout, six turns that never produced a citable claim — returns a typed
 *   error, and `chat-render.ts` then tries the corpus path and finally
 *   exports the video flagged `ungrounded`. An upgrade must not become a
 *   dependency; that is the 2026-09-01 lesson and it applies to a framework
 *   exactly as it applied to a provider.
 * - **No HTTP retry.** `maxRetries: 0` on both models. A retry spends a
 *   request against a window it cannot outrun; a *turn* is different — it
 *   carries the work already done forward.
 * - **A timeout above the measured cost of a real request.**
 *   `GEMINI_RESEARCH_TIMEOUT_MS`, per invocation, not a framework default. A
 *   timeout under the real cost does not degrade a path, it deletes it
 *   quietly.
 *
 * *What the citations mean here.* They come from the provider's own
 * grounding metadata — the pages it actually consulted — so `signalId` is
 * null and `sourceKind` is `web`. That nullability is the whole reason
 * `ResearchCitation.signalId` was widened rather than filled with a
 * fabricated id.
 */

/** `sourceKind` on every citation this module produces. Distinguishes an open-web page from an ingested signal at a glance. */
export const WEB_SOURCE_KIND = "web";

const BriefShapeSchema = z.object({
  summary: z.string().min(1),
  key_points: z.array(z.string().min(1)).min(1).max(6),
  claims: z
    .array(z.object({ claim: z.string().min(1), source_title: z.string().min(1), source_url: z.string().min(1) }))
    .min(1)
    .max(8),
});

export interface GroundedResearchInput {
  /** The headline DIGEST wrote for this brief. */
  title: string;
  /** The specific argument the operator asked for. May be empty — a brief with no angle is a search for the most contested thing about the subject, not a reason to build something else. */
  angle: string;
  /** Anything the operator insisted on. Steering for the search, never asserted as fact. */
  mustInclude: string[];
}

export interface GroundedResearchOptions {
  /** The model that gets the first `maxIterations` turns. */
  model?: string;
  /** The model that continues from the leftover work when the first one does not close the brief. */
  fallbackModel?: string;
  maxIterations?: number;
  fallbackIterations?: number;
  timeoutMs?: number;
  /** Injected by the tests. Production leaves it undefined and the real model is built here. */
  buildModel?: (config: { apiKey: string; model: string }) => GroundedModel;
  /** Where a turn-by-turn account of the stage goes. Defaults to `console.warn`, which is where the operator reads an Actions log. */
  log?: (message: string) => void;
}

/** What the stage produced, and whether the model the operator named is the one that produced it. */
export interface GroundedResearchOutcome {
  brief: ResearchBrief;
  /**
   * Null when `model` closed the brief itself. Otherwise why the stage
   * continued on `fallbackModel` — which reaches the audit package, because
   * "which provider actually answered each reasoning stage" is a thing an
   * export may never omit.
   */
  fallbackReason: string | null;
  /** Invocations spent, across both models. Reaches the log; the operator pays for each one against a per-minute meter. */
  turnsSpent: number;
}

/**
 * The slice of a LangChain chat model this stage uses.
 *
 * Narrow on purpose: it is the seam the contract tests drive, and keeping it
 * to one method means a LangChain major version cannot quietly change what
 * this file depends on without the type failing here first.
 */
export interface GroundedModel {
  invoke(messages: (SystemMessage | HumanMessage | AIMessage)[], config: { signal: AbortSignal }): Promise<{ content: unknown; response_metadata?: unknown }>;
}

function driverError(kind: DriverError["kind"], message: string): DriverError {
  return { kind, message, retryable: false };
}

/** The JSON object in a model reply that may also contain prose or a fence. Returns null when there is none. */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

/** LangChain content is a string or an array of parts; both shapes reduce to the text the model wrote. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : ""))
    .join("");
}

/**
 * The pages the provider says it actually consulted, read off the grounding
 * metadata rather than off the model's prose.
 *
 * This is the honest source of a citation's URL and it is why the model is
 * never asked to emit one it invented: a grounded answer knows which pages
 * it used, and anything the model types that is not in this list is a claim
 * about a page rather than a page. Absent or unreadable metadata yields an
 * empty list, which downgrades the brief rather than inventing provenance.
 */
export function groundingSources(metadata: unknown): { title: string; url: string }[] {
  if (typeof metadata !== "object" || metadata === null) return [];
  const grounding = (metadata as { groundingMetadata?: unknown }).groundingMetadata;
  if (typeof grounding !== "object" || grounding === null) return [];
  const chunks = (grounding as { groundingChunks?: unknown }).groundingChunks;
  if (!Array.isArray(chunks)) return [];

  const out: { title: string; url: string }[] = [];
  for (const chunk of chunks) {
    if (typeof chunk !== "object" || chunk === null) continue;
    const web = (chunk as { web?: unknown }).web;
    if (typeof web !== "object" || web === null) continue;
    const { uri, title } = web as { uri?: unknown; title?: unknown };
    if (typeof uri !== "string" || uri.length === 0) continue;
    out.push({ title: typeof title === "string" && title.length > 0 ? title : uri, url: uri });
  }
  return out;
}

function systemPrompt(): string {
  return [
    "You are the research stage of a short-form video pipeline. The operator has asked for a video",
    "about a specific thing. Find out what is actually true about it, right now, using search.",
    "",
    "Reply with JSON and nothing else:",
    '{ "summary": "...", "key_points": ["..."], "claims": [{ "claim": "...", "source_title": "...", "source_url": "..." }] }',
    "",
    "Rules that matter more than completeness:",
    "1. Every claim must come from a page you actually read in this session. Do not cite from memory.",
    "2. If the sources disagree, say so in the summary. A disagreement is the most useful thing you can find.",
    "3. If you could not find out, say so in the summary and give the claims you did verify. A short honest",
    "   brief is worth more than a long one with an invented source in it — a human reviews this and checks",
    "   the links, and one bad link costs the whole brief its credibility.",
    "4. Research the subject you were given. If it is thin, the thing to find is the most contested part of",
    "   it — never a different subject that happens to be easier to source.",
  ].join("\n");
}

function userPrompt(input: GroundedResearchInput): string {
  return [
    `Subject: ${input.title}`,
    ...(input.angle.length > 0
      ? [`The operator's angle: ${input.angle}`]
      : ["The operator gave no specific angle. Find the most contested thing about this subject."]),
    ...(input.mustInclude.length > 0
      ? ["", "The operator insisted these be covered (verify them; do not assume they are true):", ...input.mustInclude.map((item) => `- ${item}`)]
      : []),
  ].join("\n");
}

/**
 * The work one turn leaves behind: the pages search actually returned, and
 * the model's own last draft.
 *
 * This is what "continuing from the leftover work" means concretely. It is
 * accumulated across every turn on both models, which also widens the trust
 * boundary in exactly the right direction: a claim is citable if *any* turn
 * of this stage grounded on its URL, because every one of those pages was
 * genuinely fetched by the provider for this brief.
 */
interface Workpad {
  /** Every grounded page seen this stage, keyed by URL so a page found twice is one source. */
  sources: Map<string, { title: string; url: string }>;
  /** The last reply that did not close the brief. Empty before there is one. */
  lastDraft: string;
  /** Why the last turn did not close the brief. Null before there has been one. */
  lastFailure: DriverError | null;
  /** Invocations spent so far, across both models. */
  turns: number;
}

/** How much of a non-closing reply is worth carrying to the next model. Enough to keep a real draft, short of pasting a whole failed answer into a fresh context. */
const DRAFT_CARRY_CHARS = 4_000;

/** What the next turn is told, when the last one did not close the brief. */
function nudge(reason: string, turnsLeft: number): string {
  return [
    `That reply could not be used: ${reason}.`,
    turnsLeft > 1 ? `You have ${turnsLeft} turns left. Search again if you need to.` : "This is your last turn.",
    "Reply with the JSON object and nothing else. Every claim's source_url must be a page you actually opened.",
  ].join(" ");
}

/** The leftover work, as plain text, for a model that was not in the conversation that produced it. */
function handover(pad: Workpad, input: GroundedResearchInput): string {
  const sources = [...pad.sources.values()];
  return [
    "Another model was researching this and did not finish. Here is its work. Continue from it.",
    "",
    sources.length > 0
      ? ["Pages its searches actually returned — you may cite any of these, and you may search for more:", ...sources.map((s) => `- ${s.title} — ${s.url}`)].join("\n")
      : "Its searches returned no usable pages. Start the search yourself.",
    ...(pad.lastDraft.length > 0 ? ["", "Its last draft, which was not usable:", pad.lastDraft.slice(0, DRAFT_CARRY_CHARS)] : []),
    ...(pad.lastFailure !== null ? ["", `Why it was not usable: ${pad.lastFailure.message}`] : []),
    "",
    userPrompt(input),
  ].join("\n");
}

/**
 * Builds the real grounded model. Isolated so the tests never construct one
 * and production never has an injected one.
 *
 * `maxRetries: 0` and an explicit `timeout` are the two settings that are
 * not defaults and must not become them again — see the header.
 */
function defaultBuildModel(config: { apiKey: string; model: string }): GroundedModel {
  return new ChatGoogleGenerativeAI({
    apiKey: config.apiKey,
    model: config.model,
    temperature: 0.3,
    maxRetries: 0,
  }).bindTools([{ googleSearch: {} }]) as unknown as GroundedModel;
}

/** A thrown framework error, classified. The kind is what the caller logs and what the audit package reports. */
function classify(cause: unknown, model: string): DriverError {
  const message = cause instanceof Error ? cause.message : String(cause);
  const kind: DriverError["kind"] = /timeout|abort/i.test(message) ? "timeout" : /429|quota|rate/i.test(message) ? "rate_limited" : "provider_error";
  return driverError(kind, `grounded research failed on ${model}: ${message}`);
}

/**
 * One model's turns at the brief.
 *
 * Returns the brief the moment a turn produces one that is both parseable
 * and traceable. Anything else — a reply with no JSON, a schema miss, claims
 * none of which name a page search returned — is written to the workpad and
 * fed back as a nudge, because a model that searched and then wrote badly
 * has still done the expensive half of the work.
 *
 * A *thrown* error ends this model's turns immediately rather than retrying
 * it: a 429 or a timeout is a statement about the next minute, and the
 * workpad it leaves behind is what the other model continues from.
 */
async function runTurns(
  llm: GroundedModel,
  modelId: string,
  turns: number,
  opening: (SystemMessage | HumanMessage)[],
  pad: Workpad,
  timeoutMs: number,
  log: (message: string) => void,
): Promise<ResearchBrief | null> {
  const messages: (SystemMessage | HumanMessage | AIMessage)[] = [...opening];

  for (let turn = 1; turn <= turns; turn++) {
    let reply: { content: unknown; response_metadata?: unknown };
    try {
      pad.turns += 1;
      // The deadline is an AbortSignal rather than a framework option, which
      // is this project's rule for every outbound call (CLAUDE.md) and is
      // also the only one of the two that a `buildModel` double cannot
      // silently ignore. One per invocation: the cap is on a turn, not on
      // the stage, because a stage-wide deadline would abort a turn that was
      // about to answer.
      reply = await llm.invoke(messages, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (cause) {
      pad.lastFailure = classify(cause, modelId);
      log(`RESEARCH: ${modelId} turn ${turn}/${turns} threw (${pad.lastFailure.kind}: ${pad.lastFailure.message}).`);
      return null;
    }

    // Recorded before the reply is judged. A turn that searched well and
    // then wrote unusable JSON has still found pages, and those pages are
    // citable by every turn after it — including one on the other model.
    for (const source of groundingSources(reply.response_metadata)) pad.sources.set(source.url, source);

    const text = textOf(reply.content);
    const brief = readBrief(text, pad, modelId);
    if (brief.ok) {
      log(`RESEARCH: ${modelId} closed the brief on turn ${turn}/${turns} — ${brief.value.citations.length} citation(s) from ${pad.sources.size} grounded page(s).`);
      return brief.value;
    }

    pad.lastFailure = brief.error;
    pad.lastDraft = text.slice(0, DRAFT_CARRY_CHARS);
    log(`RESEARCH: ${modelId} turn ${turn}/${turns} did not close the brief (${brief.error.message}).`);
    if (turn === turns) return null;
    messages.push(new AIMessage(text), new HumanMessage(nudge(brief.error.message, turns - turn)));
  }

  return null;
}

/**
 * A reply, as a brief — or the reason it is not one.
 *
 * The trust boundary lives here, and it is why this is not simply
 * `parsed.claims`. A claim is kept only when its URL is one the provider
 * says it actually grounded on, in some turn of this stage. That is the chat
 * route's equivalent of `finalizeBrief`'s `seen` check: there, the model may
 * only cite what retrieval returned; here, it may only cite what search
 * returned. Without it a model that half-remembered a URL would put a
 * plausible dead link in front of a reviewer, which is the one failure mode
 * that makes an audit package worse than none.
 */
function readBrief(text: string, pad: Workpad, modelId: string): Result<ResearchBrief, DriverError> {
  const body = extractJsonObject(text);
  if (body === null) return err(driverError("invalid_response", "the reply contained no JSON object"));

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(body);
  } catch (cause) {
    return err(driverError("invalid_response", `the reply's JSON did not parse: ${cause instanceof Error ? cause.message : String(cause)}`));
  }

  const parsed = BriefShapeSchema.safeParse(parsedJson);
  if (!parsed.success) return err(driverError("invalid_response", `the reply's JSON does not match the brief schema: ${parsed.error.issues[0]?.message ?? "unknown"}`));

  const citations: ResearchCitation[] = parsed.data.claims.flatMap((claim) => {
    const source = pad.sources.get(claim.source_url);
    if (source === undefined) return [];
    return [{ signalId: null, claim: claim.claim, title: source.title, url: source.url, sourceKind: WEB_SOURCE_KIND }];
  });

  if (citations.length === 0) {
    return err(
      driverError(
        "invalid_response",
        `${parsed.data.claims.length} claim(s), none traceable to a page the search actually returned (${pad.sources.size} grounded source(s) so far)`,
      ),
    );
  }

  return ok({
    summary: parsed.data.summary,
    keyPoints: parsed.data.key_points,
    citations,
    toolCallsMade: [...pad.sources.keys()].map((url) => `google_search:${url}`),
    // Nothing is trimmed on this path: the whole point of grounding is that
    // the provider holds the pages, so no tool result of ours is discarded
    // to fit a request ceiling. Zero here is a fact, not a default.
    toolResultsDropped: 0,
    model: modelId,
  });
}

/**
 * Grounded research for one brief: up to four turns on the first model, then
 * up to two on the second, continuing from what the first found.
 *
 * Returns a `ResearchBrief` the rest of the pipeline cannot tell apart from
 * a corpus-built one, except by its citations' null `signalId`.
 */
export async function groundedResearch(
  geminiApiKey: string | undefined,
  input: GroundedResearchInput,
  options: GroundedResearchOptions = {},
): Promise<Result<GroundedResearchOutcome, DriverError>> {
  if (geminiApiKey === undefined || geminiApiKey.length === 0) {
    return err(driverError("not_implemented", "GEMINI_API_KEY is not set — the chat route's grounded research is unavailable"));
  }

  const model = options.model ?? GEMINI_RESEARCH_MODEL;
  const fallbackModel = options.fallbackModel ?? GEMINI_REASONING_MODEL;
  const maxIterations = options.maxIterations ?? GEMINI_RESEARCH_MAX_ITERATIONS;
  const fallbackIterations = options.fallbackIterations ?? GEMINI_RESEARCH_FALLBACK_ITERATIONS;
  const timeoutMs = options.timeoutMs ?? GEMINI_RESEARCH_TIMEOUT_MS;
  const build = options.buildModel ?? defaultBuildModel;
  const log = options.log ?? console.warn;

  const pad: Workpad = { sources: new Map(), lastDraft: "", lastFailure: null, turns: 0 };

  const first = await runTurns(build({ apiKey: geminiApiKey, model }), model, maxIterations, [new SystemMessage(systemPrompt()), new HumanMessage(userPrompt(input))], pad, timeoutMs, log);
  if (first !== null) return ok({ brief: first, fallbackReason: null, turnsSpent: pad.turns });

  // Why the first model stopped, in the words the audit package will carry.
  // `lastFailure` is only null if `maxIterations` was zero, which the config
  // does not allow and a test may.
  const reason = `${model} did not close the brief in ${pad.turns} turn(s) (${pad.lastFailure?.kind ?? "no turns"}: ${pad.lastFailure?.message ?? "none attempted"})`;
  if (fallbackIterations < 1) return err(driverError(pad.lastFailure?.kind ?? "invalid_response", reason));

  log(`RESEARCH: ${reason} — continuing on ${fallbackModel} from ${pad.sources.size} page(s) it already grounded.`);

  const second = await runTurns(
    build({ apiKey: geminiApiKey, model: fallbackModel }),
    fallbackModel,
    fallbackIterations,
    [new SystemMessage(systemPrompt()), new HumanMessage(handover(pad, input))],
    pad,
    timeoutMs,
    log,
  );
  if (second !== null) return ok({ brief: second, fallbackReason: reason, turnsSpent: pad.turns });

  return err(
    driverError(
      pad.lastFailure?.kind ?? "invalid_response",
      `grounded research produced no citable brief in ${pad.turns} turn(s) across ${model} and ${fallbackModel} — last failure: ${pad.lastFailure?.message ?? "unknown"}`,
    ),
  );
}
