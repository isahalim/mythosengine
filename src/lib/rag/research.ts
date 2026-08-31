import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { DriverError, LlmDriver, LlmMessage, ToolDefinition } from "../drivers/types.ts";
import type { ArticleFetchDriver } from "../drivers/article-fetch.ts";
import { err, ok, type Result } from "../result.ts";
import type { Retriever } from "./retriever.ts";

/**
 * RESEARCH (ARCHITECTURE.md §5.2.5) — the RAG stage that runs between SCORE
 * and SCRIPT, turning one picked signal into a grounded brief the drafting
 * prompt can stand on.
 *
 * Shape, per the operator's directive of 2026-08-30: Groq's own tool-calling
 * is the reasoning core, and the RAG pipeline is wrapped as ordinary
 * functions behind it — `search_discourse` (BM25 over the signals corpus,
 * src/lib/rag/bm25.ts) and `read_source` (the live fetch,
 * src/lib/drivers/article-fetch.ts). No agent framework is involved: the
 * loop below is thirty lines, and CrewAI/LangGraph would add a dependency
 * and an indirection without adding a capability this needs.
 *
 * Two properties this stage is built around:
 *
 * 1. **It cannot invent a citation.** Every citation is checked against what
 *    retrieval actually returned before the brief is accepted; ones that
 *    aren't are dropped, and a brief left with none is rejected outright.
 *    A grounded script whose grounding is fabricated is worse than an
 *    ungrounded one, because it reads as sourced.
 * 2. **It is allowed to fail.** RENDER treats a failed RESEARCH as a
 *    degraded path, not a dead one (scripts/pipeline/render.ts) — a
 *    retrieval outage must not cost the day's video.
 *
 * Runs on gpt-oss-20b rather than 120b: quotas are per-model (§10), so the
 * cheaper model keeps the whole 120b daily budget for SCRIPT and CRITIC,
 * and "summarize these five retrieved headlines with citations" is not a
 * task the larger model does better.
 */

const RESEARCH_MODEL = "openai/gpt-oss-20b";
const MAX_TOOL_ITERATIONS = 6;
const PROMPT_PATH = join(process.cwd(), "prompts", "research.v1.md");

/** How many signals one search_discourse call may return. Small on purpose: this text is re-sent on every subsequent iteration, so it is paid for repeatedly. */
const MAX_SEARCH_RESULTS = 8;

const CitationSchema = z.object({
  signal_id: z.string().min(1),
  claim: z.string().min(1),
});

const ResearchBriefSchema = z.object({
  summary: z.string().min(1),
  key_points: z.array(z.string().min(1)).min(1).max(6),
  citations: z.array(CitationSchema).min(1).max(8),
});

export interface ResearchCitation {
  signalId: string;
  claim: string;
  title: string;
  url: string;
  sourceKind: string;
}

export interface ResearchBrief {
  summary: string;
  keyPoints: string[];
  citations: ResearchCitation[];
  /** Every tool the agent actually ran, in order — the audit package records this so a reviewer can see what the brief was built from. */
  toolCallsMade: string[];
  model: string;
}

const TOOLS: ToolDefinition[] = [
  {
    name: "search_discourse",
    description:
      "Search the discourse this system has already ingested (Reddit, news RSS, X, YouTube) for items related to a query. Returns signal ids, titles, sources and dates. Use this first, and more than once with different wordings if the first query is thin.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords to search for. Plain words work best; this is a keyword index, not a chat box." },
        limit: { type: "integer", description: `Maximum results, 1-${MAX_SEARCH_RESULTS}.` },
      },
      required: ["query"],
    },
  },
  {
    name: "read_source",
    description:
      "Read the full text of one item returned by search_discourse, by its signal id. Use it when a headline alone doesn't tell you what actually happened. You cannot read anything that search_discourse has not returned.",
    parameters: {
      type: "object",
      properties: { signal_id: { type: "string", description: "A signal id from a search_discourse result." } },
      required: ["signal_id"],
    },
  },
];

const SearchArgsSchema = z.object({ query: z.string().min(1), limit: z.number().int().positive().optional() });
const ReadArgsSchema = z.object({ signal_id: z.string().min(1) });

function loadPromptTemplate(): string {
  return readFileSync(PROMPT_PATH, "utf8");
}

export interface ResearchOptions {
  maxIterations?: number;
  promptTemplate?: string;
  model?: string;
}

/**
 * Runs the research turn to completion and returns a validated, citation-
 * checked brief.
 *
 * `seen` is the whole trust boundary: only signals this run actually
 * retrieved may be read, and only they may be cited. The model names ids,
 * never URLs, so `read_source` can reach nothing WATCH has not already
 * ingested — see the header comment on article-fetch.ts.
 */
export async function researchSignal(
  llm: LlmDriver,
  retriever: Retriever,
  articles: Pick<ArticleFetchDriver, "fetchArticle">,
  signal: { id: string; title: string },
  options: ResearchOptions = {},
): Promise<Result<ResearchBrief, DriverError>> {
  const maxIterations = options.maxIterations ?? MAX_TOOL_ITERATIONS;
  const model = options.model ?? RESEARCH_MODEL;
  const template = options.promptTemplate ?? loadPromptTemplate();

  const seen = new Map<string, { title: string; url: string; sourceKind: string }>();
  const toolCallsMade: string[] = [];

  const messages: LlmMessage[] = [
    { role: "system", content: template.replace("{{signal_title}}", signal.title) },
    { role: "user", content: `Topic to research: ${signal.title}` },
  ];

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    // The final iteration is spent writing the brief, not calling another
    // tool — otherwise a model that keeps searching until the cap produces
    // nothing at all, having done all the work.
    const isLastIteration = iteration === maxIterations - 1;

    const completion = await llm.complete({
      model,
      messages,
      ...(isLastIteration ? {} : { tools: TOOLS, toolChoice: "auto" as const }),
      maxTokens: 1200,
      temperature: 0.3,
    });
    if (!completion.ok) return completion;

    const call = completion.value.toolCalls?.[0];
    if (!call) {
      return finalizeBrief(completion.value.content, seen, toolCallsMade, model);
    }

    messages.push({ role: "assistant", content: completion.value.content, toolCalls: [call] });

    let rawArgs: unknown;
    try {
      rawArgs = JSON.parse(call.argumentsJson);
    } catch {
      rawArgs = {};
    }

    toolCallsMade.push(call.name);
    const toolResult = await runTool(call.name, rawArgs, retriever, articles, seen);
    messages.push({ role: "tool", content: JSON.stringify(toolResult), toolCallId: call.id });
  }

  /* v8 ignore next 5 -- unreachable: the last iteration sends no tools, so it always returns above */
  return err({
    kind: "invalid_response",
    message: `RESEARCH made ${maxIterations} tool calls without producing a brief`,
    retryable: false,
  });
}

async function runTool(
  name: string,
  rawArgs: unknown,
  retriever: Retriever,
  articles: Pick<ArticleFetchDriver, "fetchArticle">,
  seen: Map<string, { title: string; url: string; sourceKind: string }>,
): Promise<unknown> {
  if (name === "search_discourse") {
    const args = SearchArgsSchema.safeParse(rawArgs);
    if (!args.success) return { error: "invalid_arguments", issues: args.error.issues };

    const hits = await retriever.search(args.data.query, Math.min(args.data.limit ?? 5, MAX_SEARCH_RESULTS));
    if (!hits.ok) return { error: hits.error.kind, message: hits.error.message };

    for (const hit of hits.value) seen.set(hit.signalId, { title: hit.title, url: hit.url, sourceKind: hit.sourceKind });
    return {
      results: hits.value.map((hit) => ({
        signal_id: hit.signalId,
        title: hit.title,
        source: hit.sourceKind,
        observed_at: hit.observedAt,
      })),
    };
  }

  if (name === "read_source") {
    const args = ReadArgsSchema.safeParse(rawArgs);
    if (!args.success) return { error: "invalid_arguments", issues: args.error.issues };

    // Not merely "unknown id" — the id has to have come back from a search
    // in *this* run. Resolving an arbitrary id straight out of the database
    // would let a guessed id turn into a fetch.
    const known = seen.get(args.data.signal_id);
    if (!known) {
      return { error: "unknown_signal_id", message: "That id did not come from a search_discourse result in this session. Search first." };
    }

    const article = await articles.fetchArticle(known.url);
    if (!article.ok) return { error: article.error.kind, message: article.error.message };
    return { signal_id: args.data.signal_id, url: known.url, text: article.value.text, truncated: article.value.truncated };
  }

  return { error: "unknown_tool", message: `no tool named ${name}` };
}

/**
 * Parses the model's final message into a brief and checks every citation
 * against what was actually retrieved. A citation naming an id the agent
 * never saw is dropped rather than trusted — and if that leaves none, the
 * whole brief is rejected, because an uncited brief is exactly the
 * ungrounded output this stage exists to replace.
 */
function finalizeBrief(
  content: string,
  seen: Map<string, { title: string; url: string; sourceKind: string }>,
  toolCallsMade: string[],
  model: string,
): Result<ResearchBrief, DriverError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(content));
  } catch (cause) {
    return err({
      kind: "invalid_response",
      message: `RESEARCH did not return JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      retryable: false,
    });
  }

  const validated = ResearchBriefSchema.safeParse(parsed);
  if (!validated.success) {
    return err({ kind: "invalid_response", message: `RESEARCH brief failed schema validation: ${validated.error.message}`, retryable: false });
  }

  const citations: ResearchCitation[] = [];
  for (const citation of validated.data.citations) {
    const source = seen.get(citation.signal_id);
    if (!source) continue;
    citations.push({ signalId: citation.signal_id, claim: citation.claim, title: source.title, url: source.url, sourceKind: source.sourceKind });
  }

  if (citations.length === 0) {
    return err({
      kind: "invalid_response",
      message: "RESEARCH produced no citation traceable to a retrieved signal",
      retryable: false,
    });
  }

  return ok({ summary: validated.data.summary, keyPoints: validated.data.key_points, citations, toolCallsMade, model });
}

/** Models wrap JSON in a fence often enough that refusing one is pedantry, not rigor. */
function stripJsonFence(content: string): string {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(content);
  return fenced ? fenced[1] : content;
}
