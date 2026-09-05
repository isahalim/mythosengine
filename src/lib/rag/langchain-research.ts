import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { err, ok, type Result } from "../result.ts";
import type { DriverError } from "../drivers/types.ts";
import { GEMINI_RESEARCH_MAX_ITERATIONS, GEMINI_RESEARCH_MODEL } from "../../config/models.ts";
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
 * *What it does NOT change.* Everything about the failure contract is the
 * same as the brainstorm route's, and deliberately so:
 *
 * - **It cannot fail a render.** Any failure — no key, a 500, a 429, a
 *   timeout, a brief with no citation — returns a typed error, and
 *   `chat-render.ts` then tries the corpus path and finally exports the video
 *   flagged `ungrounded`. An upgrade must not become a dependency; that is
 *   the 2026-09-01 lesson and it applies to a framework exactly as it
 *   applied to a provider.
 * - **Four turns.** `GEMINI_RESEARCH_MAX_ITERATIONS`, the same cap and for
 *   the same arithmetic: the free tier meters 5 requests/minute per model
 *   and a six-turn loop crossed it live.
 * - **One attempt, no HTTP retry.** `maxRetries: 0`. A retry spends a request
 *   against a window it cannot outrun.
 * - **A timeout above the measured cost of a real request.**
 *   `GEMINI_RESEARCH_TIMEOUT_MS`, not a framework default. A timeout under
 *   the real cost does not degrade a path, it deletes it quietly.
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
  /** The specific argument the operator asked for. May be empty. */
  angle: string;
  /** Anything the operator insisted on. Steering for the search, never asserted as fact. */
  mustInclude: string[];
}

export interface GroundedResearchOptions {
  model?: string;
  maxIterations?: number;
  timeoutMs?: number;
  /** Injected by the tests. Production leaves it undefined and the real model is built here. */
  buildModel?: (config: { apiKey: string; model: string }) => GroundedModel;
}

/**
 * The slice of a LangChain chat model this stage uses.
 *
 * Narrow on purpose: it is the seam the contract tests drive, and keeping it
 * to one method means a LangChain major version cannot quietly change what
 * this file depends on without the type failing here first.
 */
export interface GroundedModel {
  invoke(messages: (SystemMessage | HumanMessage)[], config: { signal: AbortSignal }): Promise<{ content: unknown; response_metadata?: unknown }>;
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

function systemPrompt(maxIterations: number): string {
  return [
    "You are the research stage of a short-form video pipeline. The operator has asked for a video",
    "about a specific thing. Find out what is actually true about it, right now, using search.",
    "",
    `You have at most ${maxIterations} search turns. Use them.`,
    "",
    "Then reply with JSON and nothing else:",
    '{ "summary": "...", "key_points": ["..."], "claims": [{ "claim": "...", "source_title": "...", "source_url": "..." }] }',
    "",
    "Rules that matter more than completeness:",
    "1. Every claim must come from a page you actually read in this session. Do not cite from memory.",
    "2. If the sources disagree, say so in the summary. A disagreement is the most useful thing you can find.",
    "3. If you could not find out, say so in the summary and give the claims you did verify. A short honest",
    "   brief is worth more than a long one with an invented source in it — a human reviews this and checks",
    "   the links, and one bad link costs the whole brief its credibility.",
  ].join("\n");
}

function userPrompt(input: GroundedResearchInput): string {
  return [
    `Subject: ${input.title}`,
    ...(input.angle.length > 0 ? [`The operator's angle: ${input.angle}`] : ["The operator gave no specific angle. Find the most contested thing about this subject."]),
    ...(input.mustInclude.length > 0 ? ["", "The operator insisted these be covered (verify them; do not assume they are true):", ...input.mustInclude.map((item) => `- ${item}`)] : []),
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

/**
 * One grounded research pass. Returns a `ResearchBrief` the rest of the
 * pipeline cannot tell apart from a corpus-built one, except by its
 * citations' null `signalId`.
 */
export async function groundedResearch(
  geminiApiKey: string | undefined,
  input: GroundedResearchInput,
  options: GroundedResearchOptions = {},
): Promise<Result<ResearchBrief, DriverError>> {
  if (geminiApiKey === undefined || geminiApiKey.length === 0) {
    return err(driverError("not_implemented", "GEMINI_API_KEY is not set — the chat route's grounded research is unavailable"));
  }

  const model = options.model ?? GEMINI_RESEARCH_MODEL;
  const maxIterations = options.maxIterations ?? GEMINI_RESEARCH_MAX_ITERATIONS;
  const timeoutMs = options.timeoutMs ?? GEMINI_RESEARCH_TIMEOUT_MS;
  const build = options.buildModel ?? defaultBuildModel;

  let reply: { content: unknown; response_metadata?: unknown };
  try {
    const llm = build({ apiKey: geminiApiKey, model });
    // The deadline is an AbortSignal rather than a framework option, which is
    // this project's rule for every outbound call (CLAUDE.md) and is also the
    // only one of the two that a `buildModel` double cannot silently ignore.
    reply = await llm.invoke([new SystemMessage(systemPrompt(maxIterations)), new HumanMessage(userPrompt(input))], {
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    // LangChain throws; every other driver in this project returns. The
    // boundary is converted here rather than let out, so the caller's
    // fail-soft path is the same shape it is for every other stage.
    const message = cause instanceof Error ? cause.message : String(cause);
    const kind: DriverError["kind"] = /timeout|abort/i.test(message) ? "timeout" : /429|quota|rate/i.test(message) ? "rate_limited" : "provider_error";
    return err(driverError(kind, `grounded research failed on ${model}: ${message}`));
  }

  const body = extractJsonObject(textOf(reply.content));
  if (body === null) return err(driverError("invalid_response", `grounded research on ${model} returned no JSON object`));

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(body);
  } catch (cause) {
    return err(driverError("invalid_response", `grounded research on ${model} returned unparseable JSON: ${cause instanceof Error ? cause.message : String(cause)}`));
  }

  const parsed = BriefShapeSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return err(driverError("invalid_response", `grounded research on ${model} returned JSON that does not match the brief schema: ${parsed.error.issues[0]?.message ?? "unknown"}`));
  }

  /**
   * The trust boundary, and the reason this is not simply `parsed.claims`.
   *
   * A claim is kept only when its URL is one the provider says it actually
   * grounded on. That is the chat route's equivalent of `finalizeBrief`'s
   * `seen` check: there, the model may only cite what retrieval returned;
   * here, it may only cite what search returned. Without it a model that
   * half-remembered a URL would put a plausible dead link in front of a
   * reviewer, which is the one failure mode that makes an audit package
   * worse than none.
   */
  const grounded = groundingSources(reply.response_metadata);
  const groundedByUrl = new Map(grounded.map((source) => [source.url, source]));
  const citations: ResearchCitation[] = parsed.data.claims.flatMap((claim) => {
    const source = groundedByUrl.get(claim.source_url);
    if (source === undefined) return [];
    return [{ signalId: null, claim: claim.claim, title: source.title, url: source.url, sourceKind: WEB_SOURCE_KIND }];
  });

  if (citations.length === 0) {
    return err(
      driverError(
        "invalid_response",
        `grounded research on ${model} produced ${parsed.data.claims.length} claim(s), none traceable to a page the search actually returned (${grounded.length} grounded source(s))`,
      ),
    );
  }

  return ok({
    summary: parsed.data.summary,
    keyPoints: parsed.data.key_points,
    citations,
    toolCallsMade: grounded.map((source) => `google_search:${source.url}`),
    // Nothing is trimmed on this path: the whole point of grounding is that
    // the provider holds the pages, so no tool result of ours is discarded
    // to fit a request ceiling. Zero here is a fact, not a default.
    toolResultsDropped: 0,
    model,
  });
}
