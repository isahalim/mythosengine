import { desc, eq } from "drizzle-orm";
import { getOne, type AppDb } from "./client.ts";
import { briefAttachments, briefs } from "./schema.ts";

/**
 * Row access for operator briefs — the chat route's unit of work (operator
 * direction, 2026-09-04).
 *
 * Shared by the Worker (which creates a brief and lists them) and the
 * pipeline (which reads one, records what DIGEST concluded, and closes it),
 * so the two ends cannot drift on what a status means. Every write here is
 * single-statement, which is why none of them needs `execAtomic`.
 */

export type BriefStatus = "queued" | "digesting" | "running" | "succeeded" | "failed";

export interface BriefAttachmentRow {
  id: string;
  briefId: string;
  position: number;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
}

export interface BriefRow {
  id: string;
  prompt: string;
  status: BriefStatus;
  traceId: string | null;
  planId: string | null;
  signalId: string | null;
  digestJson: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The R2 key one attachment's bytes live at. Derived in one place so the internal read route and the console write cannot disagree. */
export function briefAttachmentKey(briefId: string, position: number): string {
  return `briefs/${briefId}/${position}`;
}

export interface NewBriefAttachment {
  position: number;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

/** Creates a brief in `queued` with its attachment rows. The bytes are the caller's problem; this records where they are. */
export async function createBrief(
  db: AppDb,
  input: { id: string; prompt: string; attachments: NewBriefAttachment[] },
  now: () => number = Date.now,
): Promise<BriefRow> {
  const iso = new Date(now()).toISOString();
  await db.insert(briefs).values({ id: input.id, prompt: input.prompt, status: "queued", createdAt: iso, updatedAt: iso }).run();

  for (const attachment of input.attachments) {
    await db
      .insert(briefAttachments)
      .values({
        id: crypto.randomUUID(),
        briefId: input.id,
        position: attachment.position,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        storageKey: briefAttachmentKey(input.id, attachment.position),
        createdAt: iso,
      })
      .run();
  }

  return { id: input.id, prompt: input.prompt, status: "queued", traceId: null, planId: null, signalId: null, digestJson: null, failureReason: null, createdAt: iso, updatedAt: iso };
}

export async function getBrief(db: AppDb, id: string): Promise<BriefRow | null> {
  // `getOne`, never drizzle's `.get()` — over the D1 HTTP client a `.get()`
  // that matches nothing returns a truthy row of undefined fields, and every
  // `if (!row)` guard below it silently stops working (CLAUDE.md).
  const row = await getOne(db.select().from(briefs).where(eq(briefs.id, id)).limit(1));
  return row === undefined ? null : (row as BriefRow);
}

export async function listBriefs(db: AppDb, limit = 30): Promise<BriefRow[]> {
  const rows = await db.select().from(briefs).orderBy(desc(briefs.createdAt)).limit(limit).all();
  return rows as BriefRow[];
}

export async function listBriefAttachments(db: AppDb, briefId: string): Promise<BriefAttachmentRow[]> {
  const rows = await db.select().from(briefAttachments).where(eq(briefAttachments.briefId, briefId)).all();
  // Ordered here rather than in SQL: this is at most five rows, and the
  // index is on (brief_id, position) for the lookup, not the sort.
  return (rows as BriefAttachmentRow[]).sort((a, b) => a.position - b.position);
}

/**
 * Records what the run did to this brief.
 *
 * Every field is optional and only what is passed is written, because the
 * brief is updated four times across one run — dispatched, digested, running,
 * finished — and each caller knows exactly one new fact. A full-row update
 * would make the second caller responsible for preserving the first's work.
 */
export async function updateBrief(
  db: AppDb,
  id: string,
  patch: Partial<Pick<BriefRow, "status" | "traceId" | "planId" | "signalId" | "digestJson" | "failureReason">>,
  now: () => number = Date.now,
): Promise<void> {
  await db
    .update(briefs)
    .set({ ...patch, updatedAt: new Date(now()).toISOString() })
    .where(eq(briefs.id, id))
    .run();
}
