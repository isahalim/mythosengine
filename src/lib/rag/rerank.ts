import { z } from "zod";
import type { DriverError, LlmDriver } from "../drivers/types.ts";
import { GROQ_REASONING_MODEL } from "../../config/models.ts";
import { ok, type Result } from "../result.ts";
import type { RetrievedPassage, Retriever } from "./retriever.ts";

/**
 * Reranking — the second half of "use the model for the RAG calling and for
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

/**
 * Room for the model's reasoning plus one short array of small integers.
 *
 * It used to be 1024 and the answer used to be a list of **signal ids**,
 * which are 64-character sha256 hex. Twenty-four of those is ~1,700
 * characters of output before a single reasoning token, and on 2026-09-02
 * every one of a render's four RERANK calls came back
 * `json_validate_failed: max completion tokens reached before generating a
 * valid document` — the stage silently degraded to BM25 order four times in
 * one video. Ranking by position (below) removes almost all of that output,
 * and the budget covers the reasoning that remains.
 */
const RERANK_MAX_TOKENS = 1536;

/**
 * Positions, not ids.
 *
 * The model is being asked to *order* a list it was just given, and the
 * shortest honest way to say "third, then first, then seventh" is `[3, 1,
 * 7]`. Ids in the answer cost tokens in both directions — in the prompt to
 * establish them and in the completion to repeat them — and buy nothing: a
 * position outside the list is rejected by a bounds check exactly as a
 * hallucinated id was rejected by a map lookup.
 */
const RerankResponseSchema = z.object({ ranked_positions: z.array(z.number().int()) });

function buildPrompt(query: string, labels: readonly string[]): string {
  const list = labels.map((label, i) => `${i + 1}. ${label}`).join("\n");
  return `You are ranking retrieved headlines by how useful each one is for researching a specific topic.

<topic>${query}</topic>

<candidates>
${list}
</candidates>

Order the candidates from most to least useful for writing a grounded, factual brief about the topic.

Judge topical relevance, not word overlap. A headline that shares words with the topic but discusses something else is NOT relevant — that is exactly the mistake the keyword ranking already made, and the reason you are being asked. A headline that reports the actual event, its consequences, or the argument about it is relevant even if it shares no wording with the topic.

Return every candidate's NUMBER, exactly once, most useful first. Use only the numbers 1 to ${labels.length}; invent nothing.

Output JSON only, as: {"ranked_positions": [3, 1, 7]}`;
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
  const result = await rerankByLabel(llm, query, candidates, (c) => `${c.sourceKind} | ${c.title}`, topK, onEvent);
  return result.ranked;
}

/**
 * The reranking itself, over anything that can be described as one line of
 * text.
 *
 * Extracted on 2026-09-02 when the Ideas screen needed the same reordering
 * over a different row type (src/server/console/ideas-refresh.ts). The parts
 * worth sharing are not the prompt — they are the three checks under it: a
 * position off the end of the list must not conjure an item, a repeated
 * position must not duplicate one, and a partial answer must degrade to
 * "partially reranked" rather than to a silently shorter list. Those are
 * exactly the properties a second copy would get subtly wrong.
 *
 * Returns the reason alongside the order, because a caller rendering this to
 * a person needs to say why the list is merely BM25-ordered, where RESEARCH
 * only needed it logged.
 */
export async function rerankByLabel<T>(
  llm: LlmDriver,
  query: string,
  candidates: readonly T[],
  describe: (candidate: T) => string,
  topK: number,
  onEvent: (event: string) => void = () => {},
): Promise<{ ranked: T[]; reason: string | null }> {
  // Nothing to reorder. Two items are also not worth a request — the model
  // would spend a call of the daily token budget to possibly swap a pair.
  if (candidates.length < 3) return { ranked: candidates.slice(0, topK), reason: null };

  const completion = await llm.complete({
    model: GROQ_REASONING_MODEL,
    messages: [{ role: "system", content: buildPrompt(query, candidates.map(describe)) }],
    jsonSchema: true,
    maxTokens: RERANK_MAX_TOKENS,
    // Ranking is a judgement with a right answer, not a creative act.
    temperature: 0.1,
  });

  if (!completion.ok) {
    const reason = `${completion.error.kind}: ${completion.error.message}`;
    onEvent(`RERANK: ${reason} — keeping the BM25 order.`);
    return { ranked: candidates.slice(0, topK), reason };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(completion.value.content);
  } catch {
    onEvent("RERANK: the model's answer was not JSON — keeping the BM25 order.");
    return { ranked: candidates.slice(0, topK), reason: "the model's answer was not JSON" };
  }

  const validated = RerankResponseSchema.safeParse(parsed);
  if (!validated.success) {
    onEvent("RERANK: the model's answer did not match the expected shape — keeping the BM25 order.");
    return { ranked: candidates.slice(0, topK), reason: "the model's answer did not match the expected shape" };
  }

  // Only positions that were actually offered, each at most once. A model
  // that names a position off the end of the list must not be able to
  // conjure a passage, and one that repeats a position must not be able to
  // duplicate a citation. The prompt is 1-based; the array is not.
  const seen = new Set<number>();
  const ranked: T[] = [];
  for (const position of validated.data.ranked_positions) {
    const index = position - 1;
    if (index < 0 || index >= candidates.length || seen.has(index)) continue;
    seen.add(index);
    ranked.push(candidates[index]);
  }

  // Anything the model dropped keeps its BM25 position at the back, so a
  // partial answer degrades to "partially reranked" rather than to a
  // silently shorter candidate set.
  candidates.forEach((candidate, index) => {
    if (!seen.has(index)) ranked.push(candidate);
  });

  return { ranked: ranked.slice(0, topK), reason: null };
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
