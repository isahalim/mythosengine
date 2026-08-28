import { z } from "zod";
import type { AppDb, RawSqlClient } from "../../../db/client.ts";
import type { ToolDefinition } from "../../lib/drivers/types.ts";
import { DirectiveSchema } from "../console/directive-schema.ts";
import { discardExport, getExport, listExports, markExportReviewed, type ExportBlobStore, type ExportStatus } from "../console/exports.ts";
import { dryRunSettings, getSettings, updateSettings } from "../console/settings.ts";
import { dispatchRun } from "../console/dispatch.ts";
import { getConsoleSummary } from "../console/summary.ts";
import type { KvLike } from "../../lib/drivers/cache-kv.ts";
import type { VaultKv } from "../../lib/vault.ts";

export interface ToolContext {
  db: AppDb;
  rawClient: RawSqlClient;
  hotKv: KvLike & ExportBlobStore;
  vaultKv: VaultKv;
  vaultMasterKey: string;
}

export interface AgentTool {
  definition: ToolDefinition;
  /** Validates its own args (Zod) and never throws — a bad call becomes `{ok:false}`, not a crashed turn. */
  execute(ctx: ToolContext, rawArgs: unknown): Promise<{ ok: boolean; data: unknown }>;
}

function tool<TSchema extends z.ZodType>(
  name: string,
  description: string,
  parameters: object,
  schema: TSchema,
  run: (ctx: ToolContext, args: z.infer<TSchema>) => Promise<unknown>,
): AgentTool {
  return {
    definition: { name, description, parameters },
    async execute(ctx, rawArgs) {
      const parsed = schema.safeParse(rawArgs ?? {});
      if (!parsed.success) return { ok: false, data: { error: "invalid_arguments", issues: parsed.error.issues } };
      try {
        return { ok: true, data: await run(ctx, parsed.data) };
      } catch (cause) {
        return { ok: false, data: { error: cause instanceof Error ? cause.message : String(cause) } };
      }
    },
  };
}

/**
 * The chat agent's entire allowlisted surface — deliberately smaller than
 * the full /console/* API (CONSOLE_SPEC.md's plan). Key rotation and the
 * killswitch are excluded on principle, not by omission: both require a
 * fresh WebAuthn assertion an LLM cannot produce, and both are exactly the
 * two actions whose blast radius (credential swap, halting the pipeline)
 * shouldn't be reachable from a natural-language inference. Every tool here
 * calls the *same* service functions the REST routes call
 * (src/server/router.ts) — no second implementation, no separate audit
 * trail.
 */
export const AGENT_TOOLS: AgentTool[] = [
  tool("get_summary", "Get the operator console's dashboard summary: pipeline pulse, ready-for-review exports, audit flags, footage health, TTS/key status, killswitch state.", { type: "object", properties: {} }, z.object({}), async (ctx) =>
    getConsoleSummary(ctx.db, ctx.hotKv, ctx.vaultKv, ctx.vaultMasterKey),
  ),

  tool(
    "list_exports",
    "List rendered video exports, optionally filtered by status.",
    { type: "object", properties: { status: { type: "string", enum: ["ready_for_review", "downloaded", "reviewed", "discarded", "expired"] } } },
    z.object({ status: z.enum(["ready_for_review", "downloaded", "reviewed", "discarded", "expired"]).optional() }),
    async (ctx, args) => listExports(ctx.db, args.status as ExportStatus | undefined),
  ),

  tool(
    "get_export",
    "Get one export's full record by id, including its audit package.",
    { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    z.object({ id: z.string() }),
    async (ctx, args) => (await getExport(ctx.db, args.id)) ?? { error: "not_found" },
  ),

  tool(
    "mark_export_reviewed",
    "Mark a ready-for-review export as reviewed by the operator.",
    { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    z.object({ id: z.string() }),
    async (ctx, args) => markExportReviewed(ctx.db, args.id),
  ),

  tool(
    "discard_export",
    "Discard an export early, freeing its storage before the 3-day retention window ends.",
    { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    z.object({ id: z.string() }),
    async (ctx, args) => discardExport(ctx.db, ctx.hotKv, args.id),
  ),

  tool(
    "get_settings",
    "Get the currently active pipeline settings (focus games, voice pool, diversity mode, etc).",
    { type: "object", properties: {} },
    z.object({}),
    async (ctx) => (await getSettings(ctx.db)) ?? { error: "not_configured" },
  ),

  tool(
    "propose_settings_update",
    "Preview a candidate pipeline settings change against the last 20 signals WITHOUT activating it — always call this before activate_settings_update.",
    {
      type: "object",
      properties: { directive: directiveJsonSchema() },
      required: ["directive"],
    },
    z.object({ directive: DirectiveSchema }),
    async (ctx, args) => dryRunSettings(ctx.db, args.directive),
  ),

  tool(
    "activate_settings_update",
    "Activate a pipeline settings change. Only call this after propose_settings_update on the exact same directive — activation is a distinct, deliberate step, never a shortcut around the preview.",
    {
      type: "object",
      properties: { directive: directiveJsonSchema() },
      required: ["directive"],
    },
    z.object({ directive: DirectiveSchema }),
    async (ctx, args) => updateSettings(ctx.db, ctx.rawClient, args.directive, ""),
  ),

  tool("dispatch_run", "Trigger an ad hoc pipeline run (rate-limited to 10/hour, refused if the killswitch is off).", { type: "object", properties: {} }, z.object({}), async (ctx) =>
    dispatchRun(ctx.db, ctx.hotKv),
  ),
];

function directiveJsonSchema(): object {
  return {
    type: "object",
    properties: {
      focusGames: { type: "array", items: { type: "string" } },
      excludeTopics: { type: "array", items: { type: "string" } },
      minOriginalityScore: { type: "number" },
      maxUploadsPerDay: { type: "integer" },
      tone: { type: ["string", "null"], enum: ["neutral", "provocative", "analytical", null] },
      editorialNote: { type: ["string", "null"] },
      voicePool: { type: ["array", "null"], items: { type: "string" } },
      ttsRateRange: { type: ["array", "null"], items: { type: "string" } },
      preferredSourceIds: { type: "array", items: { type: "string" } },
      diversityMode: { type: "boolean" },
    },
    required: ["focusGames", "excludeTopics", "minOriginalityScore", "maxUploadsPerDay", "tone", "editorialNote", "voicePool", "ttsRateRange", "preferredSourceIds", "diversityMode"],
  };
}

