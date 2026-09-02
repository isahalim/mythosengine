import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { DriverError, LlmDriver, LlmMessage, ToolDefinition } from "../drivers/types.ts";
import type { ArticleFetchDriver } from "../drivers/article-fetch.ts";
import { err, ok, type Result } from "../result.ts";
import { GROQ_REASONING_MODEL } from "../../config/models.ts";
import { QUOTAS } from "../../config/quotas.ts";
import type { Retriever } from "./retriever.ts";

/**
 * RESEARCH (ARCHITECTURE.md §5.2.5) — the RAG stage that runs between SCORE
 * and SCRIPT, turning one picked signal into a grounded brief the drafting
 * prompt can stand on.
 *
 * Shape, per the operator's directive of 2026-08-30: the model's own
 * tool-calling is the reasoning core, and the RAG pipeline is wrapped as
 * ordinary functions behind it — `search_discourse` (BM25 over the signals corpus,
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
 * Retrieval is reranked by the same model before the agent ever sees it
 * (src/lib/rag/rerank.ts): BM25 finds the candidates, the model orders
 * them.
 *
 * This stage spent a few hours on Gemini on 2026-09-01 and was reverted the
 * same day — see `src/config/models.ts`. The reversion took `providerSteps`
 * with it: that field existed only because Gemini's Interactions API
 * cannot replay a tool conversation statelessly, and the loop below is
 * back to the plain OpenAI-shaped replay Groq accepts.
 */

/**
 * The default when RENDER does not name one. RENDER always names one, so
 * this is what a direct caller and the tests get.
 */
const RESEARCH_MODEL = GROQ_REASONING_MODEL;
const MAX_TOOL_ITERATIONS = 6;
const PROMPT_PATH = join(process.cwd(), "prompts", "research.v1.md");

/**
 * The completion budget for one research turn. Covers the model's reasoning
 * as well as the brief, and a brief carrying six key points and eight
 * citations is not small — but it is also subtracted from the per-request
 * ceiling below, so it is what the conversation has to fit *around*.
 */
const RESEARCH_MAX_TOKENS = 3072;

/** How many signals one search_discourse call may return. Small on purpose: this text is re-sent on every subsequent iteration, so it is paid for repeatedly. */
const MAX_SEARCH_RESULTS = 8;

/**
 * The largest request this stage may send, in estimated tokens.
 *
 * Groq's free tier applies its 8,000 tokens-per-minute ceiling **to a single
 * request as well as to a minute of them**, and a request bigger than the
 * whole minute is not slow — it is rejected outright, before any of it runs:
 *
 *   HTTP 413 ... "Request too large for model `openai/gpt-oss-120b` ... on
 *   tokens per minute (TPM): Limit 8000, Requested 8033"
 *
 * The rate limiter cannot prevent that. It clamps a demand larger than its
 * bucket to the bucket and lets the call through, which is correct pacing
 * behaviour and no defence at all against a payload that is simply too big.
 * So the conversation is bounded here, where it is built. RESEARCH is the
 * stage that grows: every tool result is appended and re-sent on every
 * later turn, and `read_source` returns up to 6,000 characters at a time —
 * two of those and the render's grounding is gone (2026-09-02).
 *
 * The 0.9 matches `QUOTA_SAFETY_FACTOR` in resolve-groq-driver.ts, and for
 * the same stated reason: `estimatePromptTokens` is a chars/4 floor that
 * under-reads JSON-heavy tool traffic.
 */
const REQUEST_TOKEN_CEILING = Math.floor(QUOTAS.groq.tokensPerMinute * 0.9);

/** Four characters to a token — the same floor `estimatePromptTokens` (groq.ts) uses, so the two cannot disagree about what fits. */
const CHARS_PER_TOKEN = 4;

/** What a dropped tool result is replaced with, so the transcript stays coherent and the model is told rather than left to wonder. */
const DROPPED_TOOL_RESULT = JSON.stringify({ note: "this result was dropped to stay inside the request size limit; search again if you still need it" });

/**
 * Drops the oldest tool results until the conversation fits.
 *
 * Oldest first, and tool results only. The system prompt is the
 * instructions and the first user message is the topic — losing either
 * produces a confident answer to the wrong question — and the newest
 * results are the ones the model is currently reasoning about. An assistant
 * turn that asked for a dropped result keeps its tool call, so the
 * call/result pairing the wire format requires stays intact.
 *
 * Mutates in place and reports how many it dropped, because a brief written
 * from a trimmed conversation is a brief the audit package should be able
 * to say that about.
 */
export function fitToRequestBudget(messages: LlmMessage[], maxTokens: number, ceiling = REQUEST_TOKEN_CEILING): number {
  const budgetChars = Math.max(0, ceiling - maxTokens) * CHARS_PER_TOKEN;
  const total = (): number => messages.reduce((sum, m) => sum + m.content.length, 0);
  let dropped = 0;
  for (const message of messages) {
    if (total() <= budgetChars) break;
    if (message.role !== "tool" || message.content === DROPPED_TOOL_RESULT) continue;
    message.content = DROPPED_TOOL_RESULT;
    dropped++;
  }
  return dropped;
}

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
  /**
   * How many tool results were dropped to keep the request inside Groq's
   * per-request token ceiling. Non-zero means the model finished the brief
   * without all of what it had retrieved — which is a weaker brief, not an
   * invalid one, and the reviewer is told rather than left to notice.
   */
  toolResultsDropped: number;
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
  /** The per-request token ceiling to fit inside. Overridable so a test can force trimming without building an 8,000-token conversation. */
  requestTokenCeiling?: number;
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
  let toolResultsDropped = 0;

  const messages: LlmMessage[] = [
    { role: "system", content: template.replace("{{signal_title}}", signal.title) },
    { role: "user", content: `Topic to research: ${signal.title}` },
  ];

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const isLastIteration = iteration === maxIterations - 1;
    if (isLastIteration) {
      // Said out loud rather than enforced by withholding the tools.
      // Dropping `tools` from the last request looked like the tidy way to
      // force an answer, and it is the reason the first live run 400'd:
      // Groq validates the generation against the request and rejects
      // "model called a tool" when no tool was on offer
      // (`code: "tool_use_failed"`, 2026-08-31). The tools stay on the
      // request, so a tool call is always *legal*; this message is what
      // makes it unwanted.
      messages.push({
        role: "user",
        content:
          "That is the last research turn available. Do not call any more tools — another call will be ignored. Emit the final brief as JSON now, using only what you have already retrieved.",
      });
    }

    // Bounded here rather than left to the limiter: a request over the
    // per-request TPM ceiling is refused with a 413, not queued, and the
    // render loses its grounding for a payload nobody measured.
    const dropped = fitToRequestBudget(messages, RESEARCH_MAX_TOKENS, options.requestTokenCeiling);
    if (dropped > 0) {
      toolResultsDropped += dropped;
      // Never silent: the brief the model is about to write is missing
      // something it went and fetched.
      console.warn(`RESEARCH: dropped ${dropped} tool result(s) to stay inside the ${options.requestTokenCeiling ?? REQUEST_TOKEN_CEILING}-token request ceiling.`);
    }

    const completion = await llm.complete({
      model,
      messages,
      tools: TOOLS,
      toolChoice: "auto",
      maxTokens: RESEARCH_MAX_TOKENS,
      temperature: 0.3,
    });
    if (!completion.ok) return completion;

    const call = completion.value.toolCalls?.[0];
    if (!call) {
      // The model that actually answered, not the one that was asked for.
      return finalizeBrief(completion.value.content, seen, toolCallsMade, toolResultsDropped, completion.value.modelUsed ?? model);
    }
    if (isLastIteration) {
      // Asked for a brief, reached for a tool anyway. A typed error here is
      // the designed outcome, not a crash: RENDER degrades to an ungrounded
      // script and says so in the audit package (§5.2.5).
      return err({
        kind: "invalid_response",
        message: `RESEARCH kept calling tools through all ${maxIterations} turns without producing a brief`,
        retryable: false,
      });
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

  /* v8 ignore next 5 -- unreachable: the last iteration always returns, either a brief or the error above */
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
  toolResultsDropped: number,
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

  return ok({ summary: validated.data.summary, keyPoints: validated.data.key_points, citations, toolCallsMade, toolResultsDropped, model });
}

/** Models wrap JSON in a fence often enough that refusing one is pedantry, not rigor. */
function stripJsonFence(content: string): string {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(content);
  return fenced ? fenced[1] : content;
}
