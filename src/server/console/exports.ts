import { desc, eq } from "drizzle-orm";
import { getOne, type AppDb } from "../../../db/client.ts";
import { exports as exportsTable, footageSources, footageSegments, renders, scripts } from "../../../db/schema.ts";

// Matches src/console/lib/types.ts's ExportListItem/ExportStatus exactly —
// that file is the Phase 7 frontend's already-shipped contract.
export type ExportStatus = "ready_for_review" | "downloaded" | "reviewed" | "discarded" | "expired";

export interface ExportListItem {
  id: string;
  renderId: string;
  sizeBytes: number;
  suggestedTitle: string;
  suggestedDescription: string;
  suggestedTags: string[];
  containsSyntheticMedia: boolean;
  createdAt: string;
  expiresAt: string;
  status: ExportStatus;
  footageGame: string | null;
  ttsVoice: string | null;
  scriptHook: string | null;
  durationS: number | null;
}

async function toListItem(db: AppDb, row: typeof exportsTable.$inferSelect): Promise<ExportListItem> {
  const render = await getOne(db.select().from(renders).where(eq(renders.id, row.renderId)));
  const script = render ? await getOne(db.select().from(scripts).where(eq(scripts.id, render.scriptId))) : undefined;
  const segment = render ? await getOne(db.select().from(footageSegments).where(eq(footageSegments.id, render.footageSegmentId))) : undefined;
  const source = segment ? await getOne(db.select().from(footageSources).where(eq(footageSources.id, segment.footageSourceId))) : undefined;

  let suggestedTags: string[];
  try {
    suggestedTags = JSON.parse(row.suggestedTagsJson) as string[];
  } catch {
    suggestedTags = [];
  }

  return {
    id: row.id,
    renderId: row.renderId,
    sizeBytes: row.sizeBytes,
    suggestedTitle: row.suggestedTitle,
    suggestedDescription: row.suggestedDescription,
    suggestedTags,
    containsSyntheticMedia: row.containsSyntheticMedia === 1,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    status: row.status as ExportStatus,
    footageGame: source?.game ?? null,
    ttsVoice: render?.ttsVoice ?? null,
    scriptHook: script?.hook ?? null,
    durationS: render?.durationS ?? null,
  };
}

export async function listExports(db: AppDb, status?: ExportStatus): Promise<ExportListItem[]> {
  const rows = status
    ? await db.select().from(exportsTable).where(eq(exportsTable.status, status)).orderBy(desc(exportsTable.createdAt)).all()
    : await db.select().from(exportsTable).orderBy(desc(exportsTable.createdAt)).all();
  return Promise.all(rows.map((row) => toListItem(db, row)));
}

export async function getExport(db: AppDb, id: string) {
  return getOne(db.select().from(exportsTable).where(eq(exportsTable.id, id)));
}

export type MutateExportResult = { kind: "ok" } | { kind: "not_found" };

export async function markExportReviewed(db: AppDb, id: string): Promise<MutateExportResult> {
  const existing = await getExport(db, id);
  if (!existing) return { kind: "not_found" };
  await db.update(exportsTable).set({ status: "reviewed" }).where(eq(exportsTable.id, id)).run();
  return { kind: "ok" };
}

/** The slice of Cloudflare's native KVNamespace binding the export blob store needs. */
export interface ExportBlobStore {
  get(key: string, options: { type: "arrayBuffer" }): Promise<ArrayBuffer | null>;
  delete(key: string): Promise<void>;
}

/** Discards an export early, freeing its KV blob before the 3-day TTL (CONSOLE_SPEC.md §6). */
export async function discardExport(db: AppDb, blobStore: ExportBlobStore, id: string): Promise<MutateExportResult> {
  const existing = await getExport(db, id);
  if (!existing) return { kind: "not_found" };
  await blobStore.delete(existing.storageKey);
  await db.update(exportsTable).set({ status: "discarded" }).where(eq(exportsTable.id, id)).run();
  return { kind: "ok" };
}

export type DownloadResult = { kind: "ok"; bytes: ArrayBuffer; export: typeof exportsTable.$inferSelect } | { kind: "not_found" } | { kind: "blob_missing" };

/** Streams a ready-for-review export's real MP4 from KV, and marks it downloaded (CONSOLE_SPEC.md §4/§6). */
export async function downloadExport(db: AppDb, blobStore: ExportBlobStore, id: string): Promise<DownloadResult> {
  const existing = await getExport(db, id);
  if (!existing) return { kind: "not_found" };

  const bytes = await blobStore.get(existing.storageKey, { type: "arrayBuffer" });
  if (bytes === null) return { kind: "blob_missing" };

  if (existing.status === "ready_for_review") {
    await db.update(exportsTable).set({ status: "downloaded" }).where(eq(exportsTable.id, id)).run();
  }
  return { kind: "ok", bytes, export: existing };
}
