import { eq } from "drizzle-orm";
import type { AppDb } from "../../../db/client.ts";
import { scripts } from "../../../db/schema.ts";

export type ApproveScriptResult = { kind: "ok" } | { kind: "not_found" } | { kind: "not_draft" };

/** `POST /console/scripts/:id/approve` (ARCHITECTURE.md §6). */
export async function approveScript(db: AppDb, id: string): Promise<ApproveScriptResult> {
  const existing = await db.select().from(scripts).where(eq(scripts.id, id)).get();
  if (!existing) return { kind: "not_found" };
  if (existing.status !== "draft") return { kind: "not_draft" };

  await db.update(scripts).set({ status: "approved" }).where(eq(scripts.id, id)).run();
  return { kind: "ok" };
}
