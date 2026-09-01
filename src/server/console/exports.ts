import { desc, eq } from "drizzle-orm";
import { getOne, type AppDb } from "../../../db/client.ts";
import { exports as exportsTable, footageSources, footageSegments, renders, scripts } from "../../../db/schema.ts";
import { extractKeywords } from "../../lib/pipeline/keywords.ts";

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
  /**
   * Visual keywords derived from this export's script, by the same
   * heuristic the live run's montage uses (src/lib/pipeline/keywords.ts).
   * Stage 6 searches Pexels for them so a finished video's fragments show
   * stills of what it is *about* instead of empty glass.
   *
   * Empty when the script row is gone — a keyword list is never invented
   * from the export's own title, which is model-written copy about the
   * video rather than a reading of it.
   */
  keywords: string[];
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
    keywords: script ? extractKeywords({ hook: script.hook, body: script.body, debateQuestion: script.debateQuestion }) : [],
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

export type MutateExportResult = { kind: "ok" } | { kind: "not_found" } | { kind: "no_blob_store" };

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

/** The slice of the R2 binding the export blob store needs. */
interface ExportObjectStore {
  get(key: string): Promise<{ body: ReadableStream } | null>;
  delete(key: string): Promise<void>;
}

/**
 * Where one export's bytes live.
 *
 * Export blobs moved from KV to R2 on 2026-08-31 (KV caps a value at 25 MiB;
 * a 128s render is ~42 MB). The rows written before that are still in the
 * review queue and still downloadable, so the backend is read off the key
 * rather than assumed: `exports/<id>.mp4` is an R2 object, and the older
 * `export:<id>.mp4` is a KV value. No migration, no backfill, and no moment
 * where an operator's finished video stops being reachable.
 */
function isR2Key(storageKey: string): boolean {
  return storageKey.startsWith("exports/");
}

/** Both halves of the blob store, either of which may be absent on a given deployment. */
export interface ExportStores {
  kv: ExportBlobStore;
  r2: ExportObjectStore | undefined;
}

/** Discards an export early, freeing its blob before the 3-day expiry (CONSOLE_SPEC.md §6). */
export async function discardExport(db: AppDb, stores: ExportStores, id: string): Promise<MutateExportResult> {
  const existing = await getExport(db, id);
  if (!existing) return { kind: "not_found" };

  // The row is marked discarded whether or not the blob went, and the blob
  // is deleted first: a row that says "discarded" while the bytes are still
  // there is a storage leak, and a deleted blob under a live row is a
  // download that 410s. Order matters, and this is the safer one.
  if (isR2Key(existing.storageKey)) {
    // An R2-keyed row on a Worker with no binding cannot have its blob
    // freed, and pretending otherwise would leave the object orphaned with
    // nothing recording that it exists.
    if (stores.r2 === undefined) return { kind: "no_blob_store" };
    await stores.r2.delete(existing.storageKey);
  } else {
    await stores.kv.delete(existing.storageKey);
  }

  await db.update(exportsTable).set({ status: "discarded" }).where(eq(exportsTable.id, id)).run();
  return { kind: "ok" };
}

export type DownloadResult =
  // `body` is a stream, not an ArrayBuffer: an export is tens of megabytes
  // and a Worker has a 128 MB memory ceiling. Buffering one to hand it
  // straight to a Response was affordable under KV's 25 MiB cap and is not
  // now that R2 has removed it.
  | { kind: "ok"; body: ReadableStream; export: typeof exportsTable.$inferSelect }
  | { kind: "not_found" }
  | { kind: "blob_missing" }
  | { kind: "no_blob_store" };

/**
 * A filename for the `Content-Disposition` header.
 *
 * Sanitized to a conservative ASCII slug rather than passed through: the
 * title is model-generated text that reaches this header verbatim, and a
 * quote or a newline in it would let that text break out of the header — so
 * only `[A-Za-z0-9]`, `-` and `_` survive, and the length is bounded. The
 * export id is appended so two similar titles never produce the same name in
 * a reviewer's downloads folder, and stands alone if the title slugs to
 * nothing at all (it can: a title of only emoji or punctuation).
 */
export function exportFileName(suggestedTitle: string, id: string): string {
  const slug = suggestedTitle
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return `${slug.length > 0 ? `${slug}-` : ""}${id}.mp4`;
}

/** Streams a ready-for-review export's real MP4 from wherever it lives, and marks it downloaded (CONSOLE_SPEC.md §4/§6). */
export async function downloadExport(db: AppDb, stores: ExportStores, id: string): Promise<DownloadResult> {
  const existing = await getExport(db, id);
  if (!existing) return { kind: "not_found" };

  let body: ReadableStream;
  if (isR2Key(existing.storageKey)) {
    if (stores.r2 === undefined) return { kind: "no_blob_store" };
    const object = await stores.r2.get(existing.storageKey);
    if (object === null) return { kind: "blob_missing" };
    body = object.body;
  } else {
    const bytes = await stores.kv.get(existing.storageKey, { type: "arrayBuffer" });
    if (bytes === null) return { kind: "blob_missing" };
    body = new Response(bytes).body as ReadableStream;
  }

  if (existing.status === "ready_for_review") {
    await db.update(exportsTable).set({ status: "downloaded" }).where(eq(exportsTable.id, id)).run();
  }
  return { kind: "ok", body, export: existing };
}
