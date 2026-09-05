import { eq } from "drizzle-orm";
import { getOne, type AppDb } from "../../../db/client.ts";
import { signals, sources } from "../../../db/schema.ts";
import { simhash64, simhashToHex } from "../ingest/simhash.ts";

/**
 * Turning an operator's brief into a real `signals` row (operator direction,
 * 2026-09-04).
 *
 * **This is the hinge the whole chat route turns on.** Everything downstream
 * of SCRIPT — the foreign key on `scripts.signal_id`, `claimNextRunPick`'s
 * eligibility subquery, `queuePlan`'s validation, the `scored → scripted`
 * transition — assumes a signal that genuinely exists in state `scored`. So
 * rather than teaching eleven stages about a second kind of subject, the chat
 * route mints the thing they already understand, and not one of them can tell
 * the difference. That is why the pipeline needed no second control flow.
 *
 * **Why the source is a row and not a special case.** `signals.source_id` is
 * a NOT NULL foreign key to `sources`, so a synthetic signal needs a source.
 * `operator` is that source: one row, `enabled: 0` so WATCH never polls it,
 * with a URL that is not a URL. Migration 0017 widened `sources.kind`'s CHECK
 * to admit it.
 *
 * **The side effect, stated rather than discovered.** A brief's signal joins
 * the BM25 corpus the moment it is written, so a *later* RESEARCH run can
 * retrieve and cite it. That is deliberate and mild — the row's title is a
 * headline DIGEST wrote about a real subject, and `read_source` cannot fetch
 * its `operator://` URL, so the worst case is a headline appearing in a
 * search result. Excluding it would mean teaching the retriever about source
 * kinds, which is a larger change for a smaller problem.
 */

/** The one synthetic source every operator brief hangs off. */
export const OPERATOR_SOURCE_ID = "operator";
/** Not reachable, and deliberately not http(s): nothing in this system may try to fetch it. */
const OPERATOR_SOURCE_URL = "operator://briefs";

/** The canonical URL of one brief's signal. Unique per brief, which is what `uq_signals_source_url` requires. */
export function operatorSignalUrl(briefId: string): string {
  return `operator://brief/${briefId}`;
}

/**
 * Ensures the `operator` source exists. Idempotent — called at the top of
 * every chat render rather than seeded once, because a seed that has to have
 * been run is a deployment step that will eventually not have been.
 */
export async function ensureOperatorSource(db: AppDb): Promise<void> {
  const existing = await getOne(db.select().from(sources).where(eq(sources.id, OPERATOR_SOURCE_ID)).limit(1));
  if (existing !== undefined) return;
  await db.insert(sources).values({ id: OPERATOR_SOURCE_ID, kind: "operator", url: OPERATOR_SOURCE_URL, enabled: 0 }).run();
}

export interface OperatorSignalInput {
  briefId: string;
  /** The headline DIGEST wrote. This is what SCRIPT and RESEARCH actually read. */
  title: string;
}

/**
 * Writes the brief's signal and returns its id.
 *
 * Inserted **directly as `scored`**, skipping `observed`. SCORE's job is to
 * pick a winner out of near-duplicate feed items, and there is no cluster
 * here — there is one thing the operator asked for. Passing it through
 * `observed` would put it in a duplicate-detection pass it can only lose:
 * a brief about a story already in the corpus would be rejected as a
 * duplicate of the very story the operator is trying to talk about.
 *
 * `engagementScore` is 1 rather than a computed number, and that is honest:
 * nothing observed this, so there is no engagement to report. It never
 * decides anything either, because the run claims this signal through a run
 * pick, and a claimed pick outranks the diversity weighting entirely.
 */
export async function createOperatorSignal(db: AppDb, input: OperatorSignalInput, now: () => number = Date.now): Promise<string> {
  await ensureOperatorSource(db);

  const id = crypto.randomUUID();
  await db
    .insert(signals)
    .values({
      id,
      sourceId: OPERATOR_SOURCE_ID,
      canonicalUrl: operatorSignalUrl(input.briefId),
      title: input.title,
      observedAt: new Date(now()).toISOString(),
      engagementScore: 1,
      // Computed the same way WATCH computes it (src/lib/ingest/watch.ts), so
      // this row is not a differently-shaped citizen of the table it lives in.
      simhash: simhashToHex(simhash64(input.title)),
      state: "scored",
    })
    .run();
  return id;
}
