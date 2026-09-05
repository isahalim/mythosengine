import { rm } from "node:fs/promises";
import type { DriverError, ExportDriver } from "../drivers/types.ts";
import type { AuditResult, FootageProvenance } from "./audit.ts";
import { exports as exportsTable } from "../../../db/schema.ts";
import type { AppDb } from "../../../db/client.ts";

type Db = AppDb;

/**
 * EXPORT (ARCHITECTURE.md §5.9/§9) — packages a finished render plus its
 * full audit trail and hands it to the operator's review queue. Ties
 * together the same way src/lib/footage/refresh.ts ties together its
 * drivers: takes a db handle + driver + plain inputs, does the DB write
 * itself, returns a plain result. No UploadDriver exists anywhere in this
 * system — this never calls a YouTube endpoint.
 */

/**
 * How long a finished video stays downloadable.
 *
 * Two days, operator direction 2026-09-01: "delete rendered videos after 2
 * days ... whether or not it gets downloaded or reviewed". Was three
 * (docs/DECISIONS.md). Applied to new exports only — an existing row keeps
 * the `expires_at` it was stamped with, because shortening a window the
 * operator was already told about would delete a video out from under them.
 *
 * The sweep that enforces it is `reapExpiredExports`, and it now runs from
 * WATCH as well as RENDER: it used to run only at the top of a render, so
 * "expires in two days" quietly meant "expires whenever you next make a
 * video", which for a system the operator drives by hand is not the same
 * sentence.
 */
export const EXPORT_TTL_SECONDS = 2 * 86_400;

interface CriticVerdict {
  originalityScore: number | null;
  policyFlags: string[];
  verdict: string;
  reason: string;
}

/**
 * The narration settings **actually used** — which is the phrase CLAUDE.md's
 * NEVER block and ARCHITECTURE.md §9 both use, and it has to be literally
 * true.
 *
 * It was not. These were filled in from the Edge voice and rate the
 * directive *selected*, before `selectTtsDrivers` decided whether the
 * narration would be upgraded to Gemini — so on every Gemini render the
 * audit package named a voice that never spoke (`en-US-GuyNeural` beside a
 * render row and an `auditResult.narration` both saying `Kore`, observed in
 * the first successful live run, 2026-09-01). A reviewer checking the one
 * field that claims to record what happened would have been misled by it.
 *
 * `rate`, `pitch` and `volume` are nullable because Gemini takes a style
 * direction rather than SSML-style prosody controls: null reads as "does not
 * apply to this driver", where `"+0%"` would read as a setting that was
 * chosen. `auditResult.narration` carries the style direction itself.
 */
interface TtsSettingsUsed {
  voice: string;
  rate: string | null;
  pitch: string | null;
  volume: string | null;
}

export interface ExportPackageInput {
  renderId: string;
  script: { hook: string; body: string; debateQuestion: string };
  /**
   * The critic's verdict, or null when the critic could not be reached.
   *
   * Nullable because CRITIC is advisory and no longer fails the render
   * (scripts/pipeline/render.ts). A null here is the honest record that no
   * model graded this script — `auditResult.flags` carries the matching
   * "no originality score" line — and is strictly better than a placeholder
   * verdict, which a reviewer would read as a real second opinion.
   */
  critic: CriticVerdict | null;
  footage: FootageProvenance;
  ttsSettings: TtsSettingsUsed;
  auditResult: AuditResult;
  /**
   * Exactly what the operator typed, for a chat-route video — null for a
   * brainstorm-route one, where nobody typed anything.
   *
   * §9 requires the audit package to carry what produced the video, and for
   * a chat-route video the prompt IS that: the script, the footage and the
   * research all descend from one sentence, and a reviewer who cannot see it
   * cannot tell whether the video answers what was asked. Verbatim, never a
   * summary — a summary of the input would be a second thing to audit.
   */
  operatorPrompt: string | null;
  suggestedTitle: string;
  suggestedDescription: string;
  suggestedTags: string[];
}

export interface RunExportResult {
  status: "exported" | "failed";
  exportId?: string;
  storageKey?: string;
  sizeBytes?: number;
  error?: DriverError;
}

/** Everything a human reviewer needs, assembled into exports.audit_json. */
export function assembleAuditJson(input: ExportPackageInput): string {
  return JSON.stringify({
    script: input.script,
    critic: input.critic,
    footage: input.footage,
    ttsSettings: input.ttsSettings,
    auditResult: input.auditResult,
    // Top-level rather than inside `auditResult`, because it is an *input* to
    // the run and everything in `auditResult` is a finding about the output.
    // Stage 6's Metadata sheet reads it from here.
    operatorPrompt: input.operatorPrompt,
  });
}

export async function runExport(
  db: Db,
  renderFilePath: string,
  fileBytes: Uint8Array<ArrayBuffer>,
  input: ExportPackageInput,
  drivers: { export: ExportDriver },
  options: { ttlSeconds?: number; mimeType?: string } = {},
): Promise<RunExportResult> {
  const ttlSeconds = options.ttlSeconds ?? EXPORT_TTL_SECONDS;
  const mimeType = options.mimeType ?? "video/mp4";
  // The driver names its own key: the shape is what tells the console which
  // store to read a download from (see ExportDriver.keyFor).
  const storageKey = drivers.export.keyFor(input.renderId);

  const storeResult = await drivers.export.store({ key: storageKey, bytes: fileBytes, mimeType, ttlSeconds });
  if (!storeResult.ok) {
    return { status: "failed", error: storeResult.error };
  }

  const exportId = `export-${input.renderId}`;
  const nowIso = new Date().toISOString();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

  await db
    .insert(exportsTable)
    .values({
      id: exportId,
      renderId: input.renderId,
      storageKey: storeResult.value.key,
      sizeBytes: storeResult.value.sizeBytes,
      suggestedTitle: input.suggestedTitle,
      suggestedDescription: input.suggestedDescription,
      suggestedTagsJson: JSON.stringify(input.suggestedTags),
      auditJson: assembleAuditJson(input),
      createdAt: nowIso,
      expiresAt,
      status: "ready_for_review",
    })
    .onConflictDoNothing()
    .run();

  // Only delete the local render file once the KV write is confirmed —
  // mirrors the old upload driver's "delete after upload succeeds" rule
  // (ARCHITECTURE.md §5.7), now "delete after export succeeds."
  await rm(renderFilePath, { force: true });

  return { status: "exported", exportId, storageKey: storeResult.value.key, sizeBytes: storeResult.value.sizeBytes };
}
