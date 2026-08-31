import { desc, eq } from "drizzle-orm";
import { getOne, type AppDb } from "../../../db/client.ts";
import { researchBriefs } from "../../../db/schema.ts";
import type { ResearchBrief, ResearchCitation } from "./research.ts";

/**
 * Persistence for RESEARCH briefs, kept out of `research.ts` so the agent
 * itself stays a pure function of (llm, retriever, fetcher) — which is what
 * makes it testable without a database.
 */

export interface StoredResearchBrief extends ResearchBrief {
  id: string;
  signalId: string;
  createdAt: string;
}

export async function saveResearchBrief(
  db: AppDb,
  signalId: string,
  brief: ResearchBrief,
  now: () => number = Date.now,
): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .insert(researchBriefs)
    .values({
      id,
      signalId,
      summary: brief.summary,
      keyPointsJson: JSON.stringify(brief.keyPoints),
      citationsJson: JSON.stringify(brief.citations),
      model: brief.model,
      toolCallsJson: JSON.stringify(brief.toolCallsMade),
      createdAt: new Date(now()).toISOString(),
    })
    .run();
  return id;
}

/**
 * The most recent brief for a signal, or null.
 *
 * Unreadable stored JSON degrades to null *and is logged* — it is read on
 * the export path, where a corrupt brief must cost the audit package its
 * research section rather than block the operator from downloading a
 * finished video. It is not swallowed: this can only happen if a row was
 * written by something other than `saveResearchBrief`, which is a real bug
 * and says so on the way past.
 */
export async function getLatestResearchBrief(db: AppDb, signalId: string): Promise<StoredResearchBrief | null> {
  const row = await getOne(
    db.select().from(researchBriefs).where(eq(researchBriefs.signalId, signalId)).orderBy(desc(researchBriefs.createdAt)).limit(1),
  );
  if (!row) return null;

  let keyPoints: string[];
  let citations: ResearchCitation[];
  let toolCallsMade: string[];
  try {
    keyPoints = JSON.parse(row.keyPointsJson) as string[];
    citations = JSON.parse(row.citationsJson) as ResearchCitation[];
    toolCallsMade = JSON.parse(row.toolCallsJson) as string[];
  } catch (cause) {
    console.warn(`research_briefs row ${row.id} has unreadable JSON, treating the brief as absent:`, cause);
    return null;
  }

  return {
    id: row.id,
    signalId: row.signalId,
    summary: row.summary,
    keyPoints,
    citations,
    toolCallsMade,
    model: row.model,
    createdAt: row.createdAt,
  };
}
