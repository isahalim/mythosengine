import { desc, eq } from "drizzle-orm";
import type { AppDb } from "../../../db/client.ts";
import { signals, sources } from "../../../db/schema.ts";
import { Bm25Index, tokenize } from "../../lib/rag/bm25.ts";

/**
 * Ranked ideas per topic (plan v2 §7 step 3): the operator picks one signal
 * per video, out of candidates drawn from the corpus WATCH has already
 * ingested.
 *
 * **Retrieval, not a model call.** ARCHITECTURE.md §5.2.5 makes retrieval
 * plain code — BM25 over `signals` — and the RESEARCH agent is the part
 * that spends tokens. That agent still runs, per video, inside the render
 * (scripts/pipeline/render.ts): it is what grounds the script. Ranking a
 * topic's candidates for a picker is a different job, it is interactive,
 * and it has no ambiguity a model resolves better than a scoring function.
 * Spending Groq's daily budget on a screen the operator refreshes while
 * choosing would cost real capacity for no decision quality.
 */

/** The topic set from plan v2 §7 step 2, in the order the console offers them. */
export const TOPICS = ["viral", "politics", "tech", "science", "ai", "philosophy", "concept"] as const;
export type Topic = (typeof TOPICS)[number];

export function isTopic(value: string): value is Topic {
  return (TOPICS as readonly string[]).includes(value);
}

/**
 * Each topic expanded into the terms a headline about it actually uses.
 *
 * A single-word query ("tech") retrieves almost nothing from a corpus of
 * headlines, because headlines name the thing, not the category — BM25
 * matches terms, and "tech" appears in fewer stories about technology than
 * "chip", "startup" or "app" do. Hand-written and short on purpose: this is
 * a query expansion, not a taxonomy, and every term here is one that shows
 * up in real headline text.
 */
export const TOPIC_QUERIES: Record<Topic, string> = {
  viral: "viral trending outrage backlash internet reaction video meme celebrity drama",
  politics: "politics election government policy law senate parliament vote president minister protest",
  tech: "tech technology software app startup chip platform company launch data privacy security",
  science: "science research study climate space physics biology discovery scientists experiment",
  ai: "ai artificial intelligence model chatgpt openai anthropic llm automation robot algorithm",
  philosophy: "philosophy ethics moral meaning freedom identity consciousness truth society values",
  concept: "concept idea theory future culture attention memory work loneliness modern life",
};

export interface RankedIdea {
  signalId: string;
  title: string;
  url: string;
  sourceKind: string;
  observedAt: string;
  engagementScore: number;
  /** BM25 relevance of this signal's title to the topic's expanded query. Reported, not hidden — the operator can see why an idea was offered. */
  relevance: number;
  /** How many of the topic's distinct terms the title actually contains. This, not `relevance`, is what makes a story eligible for a topic — see `rankIdeas`. */
  matchedTerms: number;
  /** The blended rank score, so the ordering is inspectable rather than magic. */
  score: number;
}

/** Newest N `scored` signals considered. Matches src/lib/rag/retriever.ts's corpus bound — same table, same reason. */
const CANDIDATE_LIMIT = 750;

/**
 * How the three signals blend. Each is normalized to 0-1 within the
 * candidate set first, so the weights mean what they look like they mean.
 *
 * Relevance alone hands the operator the most on-topic story regardless of
 * whether anyone is arguing about it, which is the opposite of what this
 * system is for (CLAUDE.md: trending, polarizing discourse). Engagement
 * alone hands them the same few loud stories under every topic.
 *
 * `MATCH` is the third weight because BM25 alone degenerates on a small
 * corpus: `isUseless` (src/lib/rag/bm25.ts) drops any term appearing in
 * more than half the documents, so when most of the corpus *is* the topic —
 * five political headlines and nothing else, which is exactly the state of
 * a fresh install — every topic term is discarded and every score is zero.
 * Term overlap does not degrade that way, so it both breaks the tie and
 * decides eligibility below.
 */
const RELEVANCE_WEIGHT = 0.45;
const ENGAGEMENT_WEIGHT = 0.35;
const MATCH_WEIGHT = 0.2;

function normalize(values: number[]): (value: number) => number {
  const max = values.reduce((highest, value) => (value > highest ? value : highest), 0);
  return (value: number) => (max <= 0 ? 0 : value / max);
}

/**
 * The topic's best candidates, highest first.
 *
 * Only `scored` signals are offered: an `observed` signal has not been
 * through SCORE, and anything past `scored` has already been written about.
 * `exclude` is the picks the operator has already made in this same
 * wizard — two videos in one run must not be the same story.
 */
export async function rankIdeas(db: AppDb, topic: Topic, limit = 5, exclude: string[] = []): Promise<RankedIdea[]> {
  const excluded = new Set(exclude);
  const rows = (await db.select().from(signals).where(eq(signals.state, "scored")).orderBy(desc(signals.observedAt)).limit(CANDIDATE_LIMIT).all()).filter(
    (row) => !excluded.has(row.id),
  );
  if (rows.length === 0) return [];

  // Two queries and a Map, not a join: `signals` and `sources` both have an
  // `id`, and a drizzle join over the D1 HTTP client collapses them into one
  // key and shifts every field after it (CLAUDE.md's NEVER block).
  const sourceRows = await db.select().from(sources).all();
  const kindBySourceId = new Map(sourceRows.map((row) => [row.id, row.kind]));

  const index = new Bm25Index(rows.map((row) => ({ id: row.id, text: row.title })));
  const hits = new Map(index.search(TOPIC_QUERIES[topic], rows.length).map((hit) => [hit.id, hit.score]));

  // The same tokenizer/stemmer both sides, for the same reason bm25.ts
  // gives: a stemming rule applied to only one side silently loses matches.
  const topicTerms = new Set(tokenize(TOPIC_QUERIES[topic]));
  const matchCount = (title: string): number => new Set(tokenize(title).filter((term) => topicTerms.has(term))).size;

  const scored = rows.map((row) => ({ row, relevance: hits.get(row.id) ?? 0, matchedTerms: matchCount(row.title) }));

  const normalizeRelevance = normalize(scored.map((candidate) => candidate.relevance));
  const normalizeEngagement = normalize(scored.map((candidate) => candidate.row.engagementScore));
  const normalizeMatches = normalize(scored.map((candidate) => candidate.matchedTerms));

  return scored
    // A candidate whose title contains none of the topic's terms is not a
    // candidate for that topic — it would be offered purely on engagement,
    // under a heading it has nothing to do with.
    .filter((candidate) => candidate.matchedTerms > 0)
    .map(({ row, relevance, matchedTerms }): RankedIdea => ({
      signalId: row.id,
      title: row.title,
      url: row.canonicalUrl,
      sourceKind: kindBySourceId.get(row.sourceId) ?? "unknown",
      observedAt: row.observedAt,
      engagementScore: row.engagementScore,
      relevance,
      matchedTerms,
      score:
        RELEVANCE_WEIGHT * normalizeRelevance(relevance) +
        ENGAGEMENT_WEIGHT * normalizeEngagement(row.engagementScore) +
        MATCH_WEIGHT * normalizeMatches(matchedTerms),
    }))
    .sort((a, b) => b.score - a.score || a.signalId.localeCompare(b.signalId))
    .slice(0, limit);
}
