import { z } from "zod";
import type { DriverError, LlmDriver } from "../drivers/types.ts";
import { LADDER_PLACEHOLDER_MODEL } from "../drivers/gemini-ladder.ts";
import { ok, type Result } from "../result.ts";
import type { RetrievedPassage, Retriever } from "./retriever.ts";

/**
 * Reranking — the second half of "use Gemini for the RAG calling and for
 * ranking too" (operator direction, 2026-09-01).
 *
 * **What BM25 gets wrong that this fixes.** BM25 ranks by term overlap, so
 * it is excellent at "which of these 750 headlines contain these words" and
 * blind to whether a headline is *about* the query. Searching a corpus of
 * political discourse for "prison overcrowding" ranks a piece titled "the
 * overcrowding of the prison of self-regard" above a sentencing-reform
 * report, because the first one says both words and the second says
 * neither. That is not a tuning problem; it is what a lexical index is.
 *
 * So the shape is the standard two-stage one: BM25 retrieves a generous
 * candidate set cheaply, and the model reorders it by actual topical
 * relevance. The model never *adds* a document — it may only reorder what
 * retrieval returned, so this cannot introduce a citation that
 * `researchSignal` would then be unable to verify.
 *
 * **It is allowed to fail, and failing is cheap.** A reranker that errors,
 * rate-limits, or returns nonsense leaves the BM25 order in place, which is
 * the order this system used until now and shipped real videos on. Nothing
 * about the brief becomes invalid; it is merely ranked less well.
 */

/** How many BM25 candidates are offered to the reranker for a request of `topK`. Three times the ask, capped — enough room to reorder meaningfully without paying to serialize the whole corpus. */
const CANDIDATE_MULTIPLIER = 3;
const MAX_CANDIDATES = 24;

/** Small: this is one short JSON array of ids, and a bigger budget would only buy longer reasoning on a ranking task. */
const RERANK_MAX_TOKENS = 1024;

const RerankResponseSchema = z.object({ ranked_signal_ids: z.array(z.string().min(1)) });

function buildPrompt(query: string, candidates: readonly RetrievedPassage[]): string {
  const list = candidates.map((c, i) => `${i + 1}. id=${c.signalId} | ${c.sourceKind} | ${c.title}`).join("\n");
  return `You are ranking retrieved headlines by how useful each one is for researching a specific topic.

<topic>${query}</topic>

<candidates>
${list}
</candidates>

Order the candidates from most to least useful for writing a grounded, factual brief about the topic.

Judge topical relevance, not word overlap. A headline that shares words with the topic but discusses something else is NOT relevant — that is exactly the mistake the keyword ranking already made, and the reason you are being asked. A headline that reports the actual event, its consequences, or the argument about it is relevant even if it shares no wording with the topic.

Return every id you were given, exactly once, most useful first. Invent nothing: only ids from the list above.

Output JSON only, as: {"ranked_signal_ids": ["...", "..."]}`;
}

/**
 * Reorders retrieval results with the model, keeping BM25's order on any
 * failure.
 *
 * The returned passages are the *same objects* retrieval produced, only
 * reordered — never re-scored and never rewritten, so provenance is
 * untouched.
 */
export async function rerankPassages(
  llm: LlmDriver,
  query: string,
  candidates: readonly RetrievedPassage[],
  topK: number,
  onEvent: (event: string) => void = () => {},
): Promise<RetrievedPassage[]> {
  // Nothing to reorder. Two items are also not worth a request — the model
  // would spend a call of a 5-per-minute budget to possibly swap a pair.
  if (candidates.length < 3) return candidates.slice(0, topK);

  const completion = await llm.complete({
    model: LADDER_PLACEHOLDER_MODEL,
    messages: [{ role: "system", content: buildPrompt(query, candidates) }],
    jsonSchema: true,
    maxTokens: RERANK_MAX_TOKENS,
    // Ranking is a judgement with a right answer, not a creative act.
    temperature: 0.1,
  });

  if (!completion.ok) {
    onEvent(`RERANK: ${completion.error.kind} (${completion.error.message}) — keeping the BM25 order.`);
    return candidates.slice(0, topK);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(completion.value.content);
  } catch {
    onEvent("RERANK: the model's answer was not JSON — keeping the BM25 order.");
    return candidates.slice(0, topK);
  }

  const validated = RerankResponseSchema.safeParse(parsed);
  if (!validated.success) {
    onEvent("RERANK: the model's answer did not match the expected shape — keeping the BM25 order.");
    return candidates.slice(0, topK);
  }

  // Only ids that were actually offered, each at most once. A model that
  // hallucinates an id must not be able to conjure a passage, and one that
  // repeats an id must not be able to duplicate a citation.
  const byId = new Map(candidates.map((c) => [c.signalId, c]));
  const seen = new Set<string>();
  const ranked: RetrievedPassage[] = [];
  for (const id of validated.data.ranked_signal_ids) {
    const passage = byId.get(id);
    if (passage === undefined || seen.has(id)) continue;
    seen.add(id);
    ranked.push(passage);
  }

  // Anything the model dropped keeps its BM25 position at the back, so a
  // partial answer degrades to "partially reranked" rather than to a
  // silently shorter candidate set.
  for (const candidate of candidates) {
    if (!seen.has(candidate.signalId)) ranked.push(candidate);
  }

  return ranked.slice(0, topK);
}

/**
 * A `Retriever` that reranks with the model before answering.
 *
 * Implemented as a wrapper rather than as changes inside
 * `SignalsBm25Retriever` because ranking and retrieval are genuinely
 * separate concerns, and the `Retriever` interface is the seam
 * ARCHITECTURE.md §5.2.5 already names for exactly this. RESEARCH does not
 * know it is talking to a reranked retriever, and the BM25 tests keep
 * testing BM25.
 */
export class RerankingRetriever implements Retriever {
  constructor(
    private readonly inner: Retriever,
    private readonly llm: LlmDriver,
    private readonly onEvent: (event: string) => void = (event) => console.warn(event),
  ) {}

  async search(query: string, topK: number): Promise<Result<RetrievedPassage[], DriverError>> {
    const candidates = await this.inner.search(query, Math.min(topK * CANDIDATE_MULTIPLIER, MAX_CANDIDATES));
    if (!candidates.ok) return candidates;
    return ok(await rerankPassages(this.llm, query, candidates.value, topK, this.onEvent));
  }

  get(signalId: string): Promise<Result<RetrievedPassage | null, DriverError>> {
    return this.inner.get(signalId);
  }
}
