import { desc } from "drizzle-orm";
import type { AppDb } from "../../../db/client.ts";
import { signals, sources } from "../../../db/schema.ts";
import type { DriverError } from "../drivers/types.ts";
import { ok, type Result } from "../result.ts";
import { Bm25Index } from "./bm25.ts";

/**
 * One retrieved item of context, carrying enough provenance to be cited.
 * `signalId` is what the RESEARCH agent's `read_source` tool takes — it
 * never gets to name a URL, so the fetch leg can only ever reach a page
 * WATCH already ingested (src/lib/drivers/article-fetch.ts).
 */
export interface RetrievedPassage {
  signalId: string;
  title: string;
  url: string;
  sourceKind: string;
  observedAt: string;
  score: number;
}

/**
 * The seam between "what we retrieve over" and "how we rank it". Today
 * there is one implementation (BM25 over signals, below); an embedding
 * index built on the `EmbedDriver`/`VectorDriver` stubs would implement
 * this same interface, and the RESEARCH agent would not change.
 */
export interface Retriever {
  search(query: string, topK: number): Promise<Result<RetrievedPassage[], DriverError>>;
  /** Provenance for one already-retrieved signal, for the read-the-source tool. */
  get(signalId: string): Promise<Result<RetrievedPassage | null, DriverError>>;
}

/** Newest N signals the index is built over. Bounded because the whole corpus is loaded into memory and re-indexed per render — cheap at this size, and this is the number that keeps it cheap. */
const DEFAULT_CORPUS_LIMIT = 750;

/**
 * BM25 retrieval over the `signals` table — the discourse WATCH has already
 * ingested (ARCHITECTURE.md §5.1), which is the only corpus in this system
 * that is both topical and provenance-tracked.
 *
 * The corpus is loaded once per instance and indexed lazily on first
 * search, so an agent making four tool calls in one turn pays for one query
 * and one index build, not four.
 */
export class SignalsBm25Retriever implements Retriever {
  private index: Bm25Index | undefined;
  private byId = new Map<string, RetrievedPassage>();
  private loaded = false;

  constructor(
    private readonly db: AppDb,
    private readonly corpusLimit: number = DEFAULT_CORPUS_LIMIT,
  ) {}

  private async load(): Promise<void> {
    if (this.loaded) return;

    // Two queries and a Map, deliberately, rather than one SQL join.
    //
    // A drizzle join over the D1 HTTP client returns *corrupted* rows: the
    // generated select list is unaliased (`"signals"."id", ... "sources"."id"`),
    // D1's REST response is a column-keyed JSON object, and two columns named
    // `id` collapse into one key — so the row arrives a value short, and
    // `Object.values` shifts every field after the collision by one. Verified
    // against the live database on 2026-08-31: the surviving `id` was the
    // *source's*, not the signal's. Nothing downstream could detect that; it
    // would just cite the wrong thing.
    //
    // Both tables are small and read whole here anyway, so joining in memory
    // costs one extra round trip and removes the hazard entirely.
    const signalRows = await this.db.select().from(signals).orderBy(desc(signals.observedAt)).limit(this.corpusLimit).all();
    const sourceRows = await this.db.select().from(sources).all();
    const kindBySourceId = new Map(sourceRows.map((row) => [row.id, row.kind]));

    for (const row of signalRows) {
      const sourceKind = kindBySourceId.get(row.sourceId);
      // A signal whose source row is gone can still be retrieved and cited —
      // the title and URL are what ground the script, and the source's kind
      // is only a label on the citation.
      this.byId.set(row.id, {
        signalId: row.id,
        title: row.title,
        url: row.canonicalUrl,
        sourceKind: sourceKind ?? "unknown",
        observedAt: row.observedAt,
        score: 0,
      });
    }

    this.index = new Bm25Index([...this.byId.values()].map((p) => ({ id: p.signalId, text: p.title })));
    this.loaded = true;
  }

  async search(query: string, topK: number): Promise<Result<RetrievedPassage[], DriverError>> {
    await this.load();
    const hits = this.index?.search(query, topK) ?? [];
    return ok(hits.map((hit) => ({ ...(this.byId.get(hit.id) as RetrievedPassage), score: hit.score })));
  }

  async get(signalId: string): Promise<Result<RetrievedPassage | null, DriverError>> {
    await this.load();
    return ok(this.byId.get(signalId) ?? null);
  }
}
