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

/**
 * One clip of a finished video, as the upload sheet shows it.
 *
 * Two spans, never conflated: `outStartS`/`outEndS` say when it is on
 * screen in the short, `sourceStartS`/`sourceEndS` say which part of the
 * source it was taken from. `linkUrl` is the second one made clickable —
 * a YouTube watch URL with `&t=` at the start of the window — so checking
 * a shot's provenance is one click rather than an arithmetic exercise.
 */
interface ExportClipUse {
  position: number;
  provider: string | null;
  providerClipId: string | null;
  photographer: string | null;
  searchQuery: string | null;
  beatIndex: number | null;
  outStartS: number;
  outEndS: number;
  sourceStartS: number | null;
  sourceEndS: number | null;
  pageUrl: string | null;
  linkUrl: string | null;
  /** What EDIT did to this clip, if anything. Null when the export predates the stage or EDIT did not run. */
  edited: boolean | null;
  editToolsRun: string[];
  editSkippedReason: string | null;
}

/**
 * Everything the operator needs in front of them at the YouTube Studio
 * upload form, plus the answer to "did this video use any YouTube footage,
 * and which".
 *
 * Assembled from `exports.audit_json`, which is the record the render
 * actually wrote — never recomputed from the live footage tables, which by
 * design no longer hold this video's clips (CLAUDE.md: nothing is retained
 * past the video it was sourced for). Every field is nullable or empty
 * rather than defaulted, so an older export renders as an older export.
 */
export interface ExportMetadata {
  id: string;
  renderId: string;
  suggestedTitle: string;
  suggestedDescription: string;
  tags: string[];
  /** The same tags in the form that goes in a description box. */
  hashtags: string[];
  containsSyntheticMedia: boolean;
  durationS: number | null;
  scriptHook: string | null;
  debateQuestion: string | null;
  narrationDriver: string | null;
  narrationVoice: string | null;
  narrationFallbackReason: string | null;
  captionTiming: string | null;
  /** True when RESEARCH failed and the script was written without retrieved grounding. */
  ungrounded: boolean;
  researchCitations: { title: string; url: string }[];
  clips: ExportClipUse[];
  /** Straight answer to "did it use YouTube?" — false means every frame came from stock. */
  usedYoutube: boolean;
  /** Present when the export was written before a field existed, so the UI can say so instead of showing blanks. */
  incomplete: string[];
}

/** A `#tag` from a plain tag: YouTube's own rules — no spaces, no punctuation carried in. */
function toHashtag(tag: string): string {
  const slug = tag.replace(/[^\p{L}\p{N}]+/gu, "");
  return slug.length > 0 ? `#${slug}` : "";
}

/**
 * A watch URL that opens at the moment the clip was taken from.
 *
 * YouTube only: a Pexels page has no time index, and appending one would
 * invent a link that does not do what it says. Whole seconds, because `t=`
 * is seconds and a fractional one is silently dropped.
 */
function deepLink(provider: string | null, pageUrl: string | null, sourceStartS: number | null): string | null {
  if (pageUrl === null) return null;
  if (provider !== "youtube" || sourceStartS === null) return pageUrl;
  const separator = pageUrl.includes("?") ? "&" : "?";
  return `${pageUrl}${separator}t=${Math.max(0, Math.floor(sourceStartS))}`;
}

interface AuditJsonShape {
  script?: { hook?: unknown; debateQuestion?: unknown };
  footage?: { parts?: unknown };
  auditResult?: { narration?: unknown; ungrounded?: unknown; research?: unknown; edit?: unknown };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function getExportMetadata(db: AppDb, id: string): Promise<ExportMetadata | null> {
  const row = await getExport(db, id);
  if (!row) return null;

  const render = await getOne(db.select().from(renders).where(eq(renders.id, row.renderId)));
  const script = render ? await getOne(db.select().from(scripts).where(eq(scripts.id, render.scriptId))) : undefined;

  let tags: string[];
  try {
    const parsed: unknown = JSON.parse(row.suggestedTagsJson);
    tags = Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    tags = [];
  }

  const incomplete: string[] = [];
  let audit: AuditJsonShape | null;
  try {
    audit = asRecord(JSON.parse(row.auditJson)) as AuditJsonShape | null;
  } catch {
    audit = null;
  }
  if (audit === null) incomplete.push("this export's audit package could not be read, so no per-clip provenance is available");

  const narration = asRecord(audit?.auditResult?.narration);
  const research = asRecord(audit?.auditResult?.research);
  const editClips = asRecord(audit?.auditResult?.edit)?.clips;
  const editByPosition = new Map<number, Record<string, unknown>>();
  if (Array.isArray(editClips)) {
    for (const entry of editClips) {
      const clip = asRecord(entry);
      const position = clip ? asNumber(clip.position) : null;
      if (clip !== null && position !== null) editByPosition.set(position, clip);
    }
  }

  const rawParts = audit?.footage?.parts;
  const clips: ExportClipUse[] = (Array.isArray(rawParts) ? rawParts : []).flatMap((entry) => {
    const part = asRecord(entry);
    if (part === null) return [];
    const position = asNumber(part.position) ?? 0;
    const provider = asString(part.provider);
    const pageUrl = asString(part.pageUrl);
    const sourceStartS = asNumber(part.sourceStartS);
    const edit = editByPosition.get(position);
    const toolsRun = Array.isArray(edit?.toolsRun) ? edit.toolsRun.filter((t): t is string => typeof t === "string") : [];
    return [
      {
        position,
        provider,
        providerClipId: asString(part.providerClipId),
        photographer: asString(part.photographer),
        searchQuery: asString(part.searchQuery),
        beatIndex: asNumber(part.beatIndex),
        outStartS: (asNumber(part.startMs) ?? 0) / 1000,
        outEndS: (asNumber(part.endMs) ?? 0) / 1000,
        sourceStartS,
        sourceEndS: asNumber(part.sourceEndS),
        pageUrl,
        linkUrl: deepLink(provider, pageUrl, sourceStartS),
        edited: typeof edit?.edited === "boolean" ? edit.edited : null,
        editToolsRun: toolsRun,
        editSkippedReason: asString(edit?.skippedReason),
      },
    ];
  });

  if (clips.length > 0 && clips.every((clip) => clip.sourceStartS === null)) {
    incomplete.push("this export predates per-clip source timestamps, so only the source video is named, not the span used");
  }

  const citations = Array.isArray(research?.citations) ? research.citations : [];

  return {
    id: row.id,
    renderId: row.renderId,
    suggestedTitle: row.suggestedTitle,
    suggestedDescription: row.suggestedDescription,
    tags,
    hashtags: tags.map(toHashtag).filter((tag) => tag.length > 0),
    containsSyntheticMedia: row.containsSyntheticMedia === 1,
    durationS: render?.durationS ?? null,
    scriptHook: script?.hook ?? asString(audit?.script?.hook),
    debateQuestion: script?.debateQuestion ?? asString(audit?.script?.debateQuestion),
    narrationDriver: asString(narration?.driver) ?? render?.ttsDriver ?? null,
    narrationVoice: asString(narration?.voice) ?? render?.ttsVoice ?? null,
    narrationFallbackReason: asString(narration?.fallbackReason),
    captionTiming: asString(narration?.captionTiming),
    ungrounded: audit?.auditResult?.ungrounded === true,
    researchCitations: citations.flatMap((entry) => {
      const citation = asRecord(entry);
      const title = citation ? asString(citation.title) : null;
      const url = citation ? asString(citation.url) : null;
      return title !== null && url !== null ? [{ title, url }] : [];
    }),
    clips,
    usedYoutube: clips.some((clip) => clip.provider === "youtube"),
    incomplete,
  };
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

/**
 * The slice of the R2 binding the export blob store needs.
 *
 * `range` is here for playback, not for download: a `<video>` asks for
 * bytes in pieces and cannot scrub without them, and R2 serves a partial
 * read without the Worker ever holding the whole object. `size` is the
 * FULL object size on a ranged read as well as an unranged one, which is
 * what `Content-Range` has to report.
 */
interface ExportObjectStore {
  get(key: string, options?: { range: { offset: number; length: number } }): Promise<{ body: ReadableStream; size: number } | null>;
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

/**
 * One byte range a media element asked for, resolved against the object's
 * real size — or `null` when the header is absent or is a form this route
 * does not serve.
 *
 * Deliberately narrow. `bytes=N-`, `bytes=N-M` and `bytes=-N` are what a
 * media element actually sends; multipart ranges are legal HTTP and no
 * browser asks a video source for one, so answering the whole file for
 * anything else is honest rather than lossy — the client re-reads what it
 * needs and playback is correct either way. `null` means "serve the whole
 * thing, 200", and only an out-of-bounds start is an error the caller has
 * to report as 416.
 */
export function parseByteRange(header: string | null, size: number): { start: number; end: number } | null | "unsatisfiable" {
  if (header === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;

  // `bytes=-N`: the LAST n bytes. A zero-length suffix has no answer.
  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (suffix === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(rawStart);
  if (start >= size) return "unsatisfiable";
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (end < start) return "unsatisfiable";
  return { start, end };
}

export type StreamResult =
  | { kind: "ok"; body: ReadableStream; size: number; range: { start: number; end: number } | null; export: typeof exportsTable.$inferSelect }
  | { kind: "not_found" }
  | { kind: "blob_missing" }
  | { kind: "no_blob_store" }
  | { kind: "unsatisfiable"; size: number };

/**
 * The same bytes as `downloadExport`, for watching rather than for keeping.
 *
 * Two things separate them, and both are the point:
 *
 * - **It does not touch the row.** `downloadExport` moves a
 *   `ready_for_review` export to `downloaded`, because the operator now
 *   holds the file. Pressing play in the console is not that, and a queue
 *   that marks a video downloaded because someone watched ten seconds of it
 *   is a queue that has stopped telling the truth about what has left the
 *   building.
 * - **It serves ranges.** A `<video>` asks for bytes in pieces and its
 *   scrubber does not work without them. `downloadExport` never needed to:
 *   a download is one sequential read.
 *
 * It also never sends `Content-Disposition: attachment`, which is what
 * would otherwise make a browser save the file instead of playing it.
 */
export async function streamExport(db: AppDb, stores: ExportStores, id: string, rangeHeader: string | null): Promise<StreamResult> {
  const existing = await getExport(db, id);
  if (!existing) return { kind: "not_found" };

  if (isR2Key(existing.storageKey)) {
    if (stores.r2 === undefined) return { kind: "no_blob_store" };
    // Two reads on a ranged request: the first learns the size (a HEAD-like
    // get of one byte), the second is the range itself. R2 charges class-B
    // operations, not bytes read, and the alternative is holding a 40 MB
    // object in a Worker with a 128 MB ceiling to measure it.
    if (rangeHeader === null) {
      const whole = await stores.r2.get(existing.storageKey);
      if (whole === null) return { kind: "blob_missing" };
      return { kind: "ok", body: whole.body, size: whole.size, range: null, export: existing };
    }
    const probe = await stores.r2.get(existing.storageKey, { range: { offset: 0, length: 1 } });
    if (probe === null) return { kind: "blob_missing" };
    // The probe's own single byte is never read; cancelling it releases the
    // stream instead of leaving it dangling for the request's lifetime.
    await probe.body.cancel();

    const range = parseByteRange(rangeHeader, probe.size);
    if (range === "unsatisfiable") return { kind: "unsatisfiable", size: probe.size };
    if (range === null) {
      const whole = await stores.r2.get(existing.storageKey);
      if (whole === null) return { kind: "blob_missing" };
      return { kind: "ok", body: whole.body, size: whole.size, range: null, export: existing };
    }
    const part = await stores.r2.get(existing.storageKey, { range: { offset: range.start, length: range.end - range.start + 1 } });
    if (part === null) return { kind: "blob_missing" };
    return { kind: "ok", body: part.body, size: probe.size, range, export: existing };
  }

  // The pre-2026-08-31 KV rows. KV has no partial read, so the value is
  // already whole in memory and a range is a slice of it — which is
  // affordable precisely because these are the rows from when the cap was
  // 25 MiB. No new export is ever written here.
  const bytes = await stores.kv.get(existing.storageKey, { type: "arrayBuffer" });
  if (bytes === null) return { kind: "blob_missing" };
  const range = parseByteRange(rangeHeader, bytes.byteLength);
  if (range === "unsatisfiable") return { kind: "unsatisfiable", size: bytes.byteLength };
  const slice = range === null ? bytes : bytes.slice(range.start, range.end + 1);
  return {
    kind: "ok",
    body: new Response(slice).body as ReadableStream,
    size: bytes.byteLength,
    range,
    export: existing,
  };
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
