import { and, eq, gte } from "drizzle-orm";
import type { AppDb } from "../../../db/client.ts";
import { briefAttachmentKey, createBrief, getBrief, listBriefs, updateBrief, listBriefAttachments, type BriefRow } from "../../../db/briefs.ts";
import { runs } from "../../../db/schema.ts";
import type { KvLike } from "../../lib/drivers/cache-kv.ts";
import type { GithubActionsDriver } from "../../lib/drivers/github-actions.ts";
import { isPipelineEnabled } from "./killswitch.ts";
import { DEFAULT_RENDER_REF, DEFAULT_RENDER_WORKFLOW, DISPATCH_NOT_TRIGGERED_NOTE, DISPATCH_STAGE } from "./dispatch.ts";

/**
 * `POST /console/briefs` — the chat route's one write (operator direction,
 * 2026-09-04).
 *
 * **This file makes no model call, and that is the whole reason it looks the
 * way it does.** The Worker holds no model credential (CLAUDE.md) and none
 * was added for the chat route. So this endpoint does exactly three things —
 * store the prompt, store the attachments, start a run — and every judgement
 * the chat surface appears to make (what topic is this? is it specific enough
 * to build? what should the video be called?) is made by DIGEST on the
 * runner, which writes its answer back onto the brief row. The operator
 * watches the run rather than waiting on a reply, which is also what the
 * design board describes: the orb rises the moment they press enter.
 *
 * **Why it dispatches rather than queueing a run plan.** A plan names a
 * signal, and at this moment no signal exists — for a specific idea DIGEST
 * has to mint one, and for a vague one it has to rank the corpus. Both need a
 * model. So the workflow is dispatched with `brief_id` instead of `plan_id`,
 * and `scripts/pipeline/chat-render.ts` builds the plan on the far side. The
 * two inputs are mutually exclusive by construction: a brief-scoped run
 * queues its own plan and binds itself to it.
 */

/** One submission's ceiling. Not a quota — a bound on a single form, in the spirit of `MAX_VIDEOS_PER_PLAN`. */
export const MAX_BRIEF_ATTACHMENTS = 5;
/** Total attachment bytes one brief may carry. R2 could take far more; DIGEST reading far more could not. */
export const MAX_BRIEF_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** The longest prompt accepted. Long enough for a paragraph of direction, short enough that the whole of it fits in DIGEST's request. */
export const MAX_BRIEF_PROMPT_CHARS = 4_000;

/**
 * What DIGEST may be handed. Anything else is refused at upload with its
 * type named, rather than stored and then silently ignored on the runner.
 *
 * Text types are decoded directly with no model involved; images and PDFs
 * need a multimodal read, which is the one place an attachment can degrade.
 */
const ACCEPTED_MIME = /^(text\/(plain|markdown|csv)|application\/(json|pdf)|image\/(png|jpeg|webp|gif))$/;

const MAX_BRIEFS_PER_HOUR = 10;

export interface BriefAttachmentInput {
  filename: string;
  mimeType: string;
  bytes: Uint8Array<ArrayBuffer>;
}

export type SubmitBriefResult =
  | { kind: "ok"; brief: BriefRow; note: string | null }
  | { kind: "invalid"; message: string }
  | { kind: "disabled" }
  | { kind: "rate_limited" }
  | { kind: "no_blob_store" };

export interface SubmitBriefDeps {
  db: AppDb;
  killswitchKv: KvLike;
  /** Undefined when this Worker has no EXPORTS binding. Only required when the submission actually carries files. */
  exportBucket: R2Bucket | undefined;
  /** Null when no dispatch credential is configured — the brief is still recorded, and says so. */
  actions: GithubActionsDriver | null;
  workflow?: string;
  ref?: string;
  now?: () => number;
}

/** Validates one submission before anything is written. Returns the reason, never a partial write. */
function validate(prompt: string, attachments: BriefAttachmentInput[]): string | null {
  const trimmed = prompt.trim();
  if (trimmed.length === 0) return "a brief needs a prompt";
  if (trimmed.length > MAX_BRIEF_PROMPT_CHARS) return `a prompt is capped at ${MAX_BRIEF_PROMPT_CHARS} characters`;
  if (attachments.length > MAX_BRIEF_ATTACHMENTS) return `a brief may carry at most ${MAX_BRIEF_ATTACHMENTS} attachments`;

  const total = attachments.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  if (total > MAX_BRIEF_ATTACHMENT_BYTES) return `attachments are capped at ${MAX_BRIEF_ATTACHMENT_BYTES} bytes in total (this submission was ${total})`;

  for (const file of attachments) {
    if (!ACCEPTED_MIME.test(file.mimeType)) return `"${file.filename}" is a ${file.mimeType}, which the digest cannot read — send text, JSON, CSV, PDF or an image`;
  }
  return null;
}

/**
 * Records one brief and starts the run that will build it.
 *
 * Ordered so that nothing is dispatched for a brief that does not exist and
 * nothing is stored for a brief that was refused: validate, put the bytes,
 * write the rows, then dispatch. A dispatch that fails leaves a real brief
 * row marked `failed` with the reason on it — the operator sees why, and
 * re-submitting is one click, exactly as a failed dispatch is on the
 * brainstorm route.
 */
export async function submitBrief(
  prompt: string,
  attachments: BriefAttachmentInput[],
  deps: SubmitBriefDeps,
): Promise<SubmitBriefResult> {
  const { db, killswitchKv, exportBucket, actions, workflow = DEFAULT_RENDER_WORKFLOW, ref = DEFAULT_RENDER_REF, now = Date.now } = deps;

  const invalid = validate(prompt, attachments);
  if (invalid !== null) return { kind: "invalid", message: invalid };

  if (!(await isPipelineEnabled(killswitchKv))) return { kind: "disabled" };

  // Shares the dispatch budget rather than having one of its own: both
  // endpoints start the same workflow on the same runner, and two separate
  // 10/hour allowances would be a 20/hour allowance wearing a disguise.
  const oneHourAgoIso = new Date(now() - 60 * 60 * 1000).toISOString();
  const recent = await db
    .select()
    .from(runs)
    .where(and(eq(runs.stage, DISPATCH_STAGE), gte(runs.startedAt, oneHourAgoIso)))
    .all();
  if (recent.length >= MAX_BRIEFS_PER_HOUR) return { kind: "rate_limited" };

  if (attachments.length > 0 && exportBucket === undefined) return { kind: "no_blob_store" };

  const briefId = crypto.randomUUID();

  // Bytes first. A stored object with no row is swept with the bucket; a row
  // pointing at an object that was never written would make DIGEST report a
  // missing attachment for a file the operator watched upload.
  for (const [position, file] of attachments.entries()) {
    await exportBucket?.put(briefAttachmentKey(briefId, position), file.bytes as unknown as ArrayBuffer, {
      httpMetadata: { contentType: file.mimeType },
    });
  }

  const brief = await createBrief(
    db,
    {
      id: briefId,
      prompt: prompt.trim(),
      attachments: attachments.map((file, position) => ({ position, filename: file.filename, mimeType: file.mimeType, sizeBytes: file.bytes.byteLength })),
    },
    now,
  );

  // The trace is decided here, for the same reason `dispatchRun` decides it:
  // GitHub's dispatch endpoint returns no run id, so the identifier has to
  // travel downward. The chat surface polls this trace, and the pipeline
  // stamps every stage with it.
  const traceId = crypto.randomUUID();
  const startedAt = new Date(now()).toISOString();
  await db.insert(runs).values({ id: traceId, startedAt, stage: DISPATCH_STAGE, status: "queued", traceId }).run();
  await updateBrief(db, briefId, { traceId }, now);

  if (actions === null) {
    await updateBrief(db, briefId, { status: "queued" }, now);
    return { kind: "ok", brief: { ...brief, traceId }, note: DISPATCH_NOT_TRIGGERED_NOTE };
  }

  const triggered = await actions.dispatchWorkflow({
    workflow,
    ref,
    // `count` is always 1: a brief is one idea and makes one video. `plan_id`
    // is empty because this run queues its own plan on the far side, once
    // DIGEST knows what signal it is building.
    inputs: { trace_id: traceId, count: "1", plan_id: "", brief_id: briefId },
  });
  const finishedAt = new Date(now()).toISOString();

  if (!triggered.ok) {
    const reason = `the GitHub Actions workflow could not be started (${triggered.error.kind}: ${triggered.error.message})`;
    await db.update(runs).set({ status: "failed", finishedAt, errorClass: `dispatch_failed:${triggered.error.kind}` }).where(eq(runs.id, traceId)).run();
    await updateBrief(db, briefId, { status: "failed", failureReason: reason }, now);
    return { kind: "ok", brief: { ...brief, traceId, status: "failed", failureReason: reason }, note: `recorded, but ${reason}` };
  }

  await db.update(runs).set({ status: "succeeded", finishedAt }).where(eq(runs.id, traceId)).run();
  return { kind: "ok", brief: { ...brief, traceId }, note: null };
}

/** One brief as the chat surface reads it — the row plus its attachment filenames, which is all the transcript shows. */
export interface BriefView extends BriefRow {
  attachments: { filename: string; mimeType: string; sizeBytes: number }[];
}

export async function listBriefViews(db: AppDb, limit = 30): Promise<BriefView[]> {
  const rows = await listBriefs(db, limit);
  // One query per brief rather than an IN over all of them: `listBriefs`
  // caps at 30 and this reads at most 30 tiny indexed rows, against the
  // alternative of an in-memory join this file would then have to own.
  // Never a drizzle `.innerJoin` — over D1's REST client two tables that
  // both have an `id` collapse into one key (CLAUDE.md).
  return Promise.all(
    rows.map(async (row) => ({
      ...row,
      attachments: (await listBriefAttachments(db, row.id)).map((a) => ({ filename: a.filename, mimeType: a.mimeType, sizeBytes: a.sizeBytes })),
    })),
  );
}

export async function getBriefView(db: AppDb, id: string): Promise<BriefView | null> {
  const row = await getBrief(db, id);
  if (row === null) return null;
  const attachments = await listBriefAttachments(db, id);
  return { ...row, attachments: attachments.map((a) => ({ filename: a.filename, mimeType: a.mimeType, sizeBytes: a.sizeBytes })) };
}
