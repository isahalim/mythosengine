/**
 * BM25 over a small in-memory corpus — the retrieval half of the RESEARCH
 * stage (ARCHITECTURE.md §5.2.5).
 *
 * Why lexical and not vectors: Groq serves no embeddings endpoint, so a
 * vector index would mean a second provider or a ~100MB local model, and
 * `EmbedDriver`/`VectorDriver` (src/lib/drivers/) are still honest Phase 4
 * stubs precisely because nobody has built the recall eval set that would
 * say whether embeddings actually retrieve better here. BM25 needs no
 * model, no network and no state, ranks well on the short, keyword-dense
 * titles this corpus is made of, and — unlike an untested embedding —
 * every number it produces can be checked by hand. `Retriever`
 * (retriever.ts) is the seam an embedding index slots into later.
 *
 * Standard Robertson/Sparck-Jones BM25 with the usual k1=1.5, b=0.75.
 */

export interface Bm25Document {
  id: string;
  text: string;
}

export interface Bm25Hit {
  id: string;
  score: number;
}

const K1 = 1.5;
const B = 0.75;

/**
 * Deliberately crude suffix stripping — plural `-s`, past `-ed`, gerund
 * `-ing`, possessive `-'s` — and nothing else. Not Porter: the full
 * algorithm's later steps mangle short headline words (`window` → `window`
 * is fine, but `series` → `seri`) for recall this corpus doesn't need.
 *
 * It is here because leaving it out was measurably wrong: the query "GTA VI
 * delay" ranked a trailer breakdown above the delay story itself, because
 * the delay story says "delayed". Only applied when at least 3 characters
 * survive, so `is`/`ads`/`bed` are left alone.
 */
function stem(token: string): string {
  for (const suffix of ["ing", "ed", "s"]) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 3) {
      // `ss` is not a plural — "loss", "press", "across".
      if (suffix === "s" && token.endsWith("ss")) return token;
      return token.slice(0, -suffix.length);
    }
  }
  return token;
}

/**
 * Lowercase, split on anything that isn't a letter/digit, drop
 * single-character noise, then stem. Query and document go through the
 * exact same function — that identity is what makes the stemmer safe: a
 * crude rule applied to both sides still matches, where a rule applied to
 * only one side silently loses documents.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 1)
    .map(stem);
}

/**
 * Words too common in *this* corpus to discriminate. Derived from the
 * corpus rather than a fixed English stop list, so it stays right when the
 * signal mix changes — a term in more than half the documents contributes
 * a near-zero (or negative) IDF anyway; dropping it just makes that
 * explicit and cheaper.
 */
function isUseless(documentFrequency: number, documentCount: number): boolean {
  return documentCount >= 4 && documentFrequency > documentCount / 2;
}

export class Bm25Index {
  private readonly termFrequencies: Map<string, number>[] = [];
  private readonly lengths: number[] = [];
  private readonly documentFrequency = new Map<string, number>();
  private readonly ids: string[] = [];
  private averageLength = 0;

  constructor(documents: Bm25Document[]) {
    for (const document of documents) {
      const tokens = tokenize(document.text);
      const frequencies = new Map<string, number>();
      for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
      for (const term of frequencies.keys()) {
        this.documentFrequency.set(term, (this.documentFrequency.get(term) ?? 0) + 1);
      }
      this.ids.push(document.id);
      this.termFrequencies.push(frequencies);
      this.lengths.push(tokens.length);
    }
    const totalLength = this.lengths.reduce((sum, length) => sum + length, 0);
    this.averageLength = this.ids.length > 0 ? totalLength / this.ids.length : 0;
  }

  get size(): number {
    return this.ids.length;
  }

  /** Highest-scoring documents first. Documents that match nothing are omitted, not returned with score 0. */
  search(query: string, topK: number): Bm25Hit[] {
    const documentCount = this.ids.length;
    if (documentCount === 0) return [];

    const queryTerms = [...new Set(tokenize(query))];
    const scores = new Float64Array(documentCount);

    for (const term of queryTerms) {
      const df = this.documentFrequency.get(term) ?? 0;
      if (df === 0 || isUseless(df, documentCount)) continue;
      // The +1 inside the log keeps IDF strictly positive, so a term
      // appearing in every document can never *subtract* from a score.
      const idf = Math.log(1 + (documentCount - df + 0.5) / (df + 0.5));

      for (let i = 0; i < documentCount; i++) {
        const tf = this.termFrequencies[i].get(term);
        if (tf === undefined) continue;
        const normalization = this.averageLength === 0 ? 1 : 1 - B + (B * this.lengths[i]) / this.averageLength;
        scores[i] += idf * ((tf * (K1 + 1)) / (tf + K1 * normalization));
      }
    }

    return this.ids
      .map((id, i) => ({ id, score: scores[i] }))
      .filter((hit) => hit.score > 0)
      // Ties broken by id so the same corpus and query always give the same
      // order — a retrieval step that shuffles under ties makes every
      // downstream failure unreproducible.
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, topK);
  }
}
