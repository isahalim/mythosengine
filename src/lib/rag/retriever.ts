import { desc, eq } from "drizzle-orm";
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

    // Bare .select() (no field-picking object), for the reason documented at
    // length in scripts/pipeline/render.ts: drizzle's field-mapping overload
    // collapses to 0 arguments when the receiver is typed as AppDb, so the
    // nested `row.signals` / `row.sources` shape below is the only one that
    // typechecks across all three dialects.
    const rows = await this.db
      .select()
      .from(signals)
      .innerJoin(sources, eq(sources.id, signals.sourceId))
      .orderBy(desc(signals.observedAt))
      .limit(this.corpusLimit)
      .all();

    for (const row of rows) {
      this.byId.set(row.signals.id, {
        signalId: row.signals.id,
        title: row.signals.title,
        url: row.signals.canonicalUrl,
        sourceKind: row.sources.kind,
        observedAt: row.signals.observedAt,
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
