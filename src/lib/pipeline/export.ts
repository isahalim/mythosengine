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

export const EXPORT_TTL_SECONDS = 3 * 86_400; // 3 days, operator-chosen — docs/DECISIONS.md

interface CriticVerdict {
  originalityScore: number | null;
  policyFlags: string[];
  verdict: string;
  reason: string;
}

interface TtsSettingsUsed {
  voice: string;
  rate: string;
  pitch: string;
  volume: string;
}

export interface ExportPackageInput {
  renderId: string;
  script: { hook: string; body: string; debateQuestion: string };
  critic: CriticVerdict;
  footage: FootageProvenance;
  ttsSettings: TtsSettingsUsed;
  auditResult: AuditResult;
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
  const storageKey = `export:${input.renderId}.mp4`;

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
