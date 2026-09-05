import { createD1HttpDb } from "../../db/d1-http.ts";
import { WorkerBatchClient } from "../../db/worker-batch.ts";
import type { AppDb, RawSqlClient } from "../../db/client.ts";
import { KvHttpClient } from "../../src/lib/drivers/kv-http.ts";
import { R2ExportDriver } from "../../src/lib/drivers/export-r2.ts";
import { openLocalBackend } from "./local-backend.ts";
import type { KvLike } from "../../src/lib/drivers/cache-kv.ts";
import type { ExportDriver } from "../../src/lib/drivers/types.ts";

// Committed, non-secret resource ids (PROVISIONED.md / wrangler.toml — same
// values already public in that file, not something worth a GitHub Actions
// secret of its own).
const D1_DATABASE_ID = "77a0969e-2fb8-460e-9e52-f2606b2fa2fa";
export const HOT_KV_NAMESPACE_ID = "e1a2adff832742ae8953cab9905a7aa6";
/**
 * PROVISIONED.md's "Live URL". Non-secret and already public in that file;
 * overridable via `WORKER_URL` for a staging deploy.
 *
 * This is the only place the pipeline learns where the Worker lives, and no
 * workflow sets `WORKER_URL`, so this constant *is* the production origin. It
 * changed on 2026-09-04 when the operator renamed the account subdomain from
 * `5ryfrrjgmg` to `isahalim` — worth stating what a stale value costs, because
 * it is not a startup failure. Reads go straight at the D1 and KV REST APIs and
 * would keep working; only `execAtomic` and the export blob PUT come through
 * here. A render would poll signals, spend the whole RESEARCH/SCRIPT/EDIT
 * budget, encode the video, and only then fail writing it. Anything that moves
 * the Worker moves this line with it.
 */
const DEFAULT_WORKER_URL = "https://mythosengine.isahalim.workers.dev";

/** CLAUDE.md: "never ask for a secret value... name the exact variable and stop" — this is that check, centralized. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}. Set it as a GitHub Actions repository secret (see PROVISIONED.md) before running this workflow.`);
  }
  return value;
}

export function optionalEnv(name: string): string | undefined {
  return process.env[name] || undefined;
}

/**
 * The slice of KV the pipeline actually uses: plain string get/put. It
 * reads the killswitch and writes cache entries; it never reads a blob
 * back (that is the console's download path) and never deletes one (that
 * is discard). Keeping the type this narrow is what lets a disk-backed
 * local store satisfy it without pretending to be a KV namespace.
 */
export type PipelineKv = KvLike;

export interface PipelineEnv {
  db: AppDb;
  rawClient: RawSqlClient;
  hotKv: PipelineKv;
  /**
   * Where a finished render is stored. Owned by the env rather than
   * constructed in render.ts, because it is the one other thing (besides
   * the database and KV) that differs between a real run and a local one.
   */
  exportDriver: ExportDriver;
  /** True when this run is against the local disk-backed backend, not Cloudflare. Stages log it so a local artefact is never mistaken for a production one. */
  local: boolean;
  groqApiKey: string;
  /**
   * Optional. Absent, TTS runs on Edge — the default path (plan v2 §5). Not
   * `requireEnv`, because a pipeline without it must keep working exactly as
   * it did before Gemini existed rather than refusing to start for want of
   * an upgrade.
   */
  geminiApiKey: string | undefined;
  /**
   * Optional, and required only by the stock-montage footage mode
   * (src/lib/footage/stock.ts). Absent, a `gameplay` run is unaffected and a
   * `stock_montage` run fails at FOOTAGE naming this variable — which is the
   * contract CLAUDE.md asks for: name the variable, do not invent a
   * fallback, and never ask for the value.
   */
  pexelsApiKey: string | undefined;
  discordWebhookUrl: string | undefined;
}

/** Every scripts/pipeline/*.ts entrypoint starts by building this — one place all the D1/KV-over-HTTP wiring lives. */
/**
 * Local end-to-end mode (`PIPELINE_LOCAL=1`).
 *
 * Swaps D1-over-HTTP and KV-over-HTTP for a SQLite file and a directory,
 * and nothing else. Every pipeline stage runs the code it always runs.
 *
 * This exists because the default env points at the ids in wrangler.toml,
 * which are the PRODUCTION database, KV namespace and review queue —
 * running the pipeline on a laptop to "see if it works" would otherwise
 * publish scripts and exports into the operator's live queue.
 */
function buildLocalPipelineEnv(): PipelineEnv {
  const backend = openLocalBackend();
  return {
    db: backend.db,
    rawClient: backend.rawClient,
    hotKv: backend.hotKv,
    exportDriver: backend.exportDriver,
    local: true,
    groqApiKey: requireEnv("GROQ_API_KEY"),
    geminiApiKey: optionalEnv("GEMINI_API_KEY"),
    pexelsApiKey: optionalEnv("PEXELS_API_KEY"),
    discordWebhookUrl: undefined, // a local run must never page the operator
  };
}

export function buildPipelineEnv(): PipelineEnv {
  if (process.env.PIPELINE_LOCAL === "1") return buildLocalPipelineEnv();

  const accountId = requireEnv("CLOUDFLARE_ACCOUNT_ID");
  const apiToken = requireEnv("CLOUDFLARE_API_TOKEN");
  const groqApiKey = requireEnv("GROQ_API_KEY");

  const d1Options = { accountId, apiToken, databaseId: D1_DATABASE_ID };

  // Built on first use, not eagerly. `rawClient` is only ever touched by a
  // multi-statement write (execAtomic), and FOOTAGE REFRESH never performs
  // one — requiring its secret up front would stop that job from running for
  // want of a credential it does not use. A job that *does* write this way
  // and lacks the secret still fails with the exact variable name, at the
  // moment it is needed.
  let rawClient: WorkerBatchClient | undefined;

  const geminiApiKey = optionalEnv("GEMINI_API_KEY");
  const workerUrl = optionalEnv("WORKER_URL") ?? DEFAULT_WORKER_URL;

  return {
    geminiApiKey,
    local: false,
    // Through the Worker, not straight at R2: this runner's
    // CLOUDFLARE_API_TOKEN has no R2 permission, and the Worker holds the
    // binding. Same shared secret and same reasoning as `rawClient` below.
    // Replaced KvExportDriver on 2026-08-31 — KV caps a value at 25 MiB and
    // a 128s render is ~42 MB (src/lib/drivers/export-r2.ts).
    exportDriver: new R2ExportDriver({ workerUrl, token: requireEnv("PIPELINE_BATCH_TOKEN") }),
    db: createD1HttpDb(d1Options),
    get rawClient(): RawSqlClient {
      rawClient ??= new WorkerBatchClient({ workerUrl, token: requireEnv("PIPELINE_BATCH_TOKEN") });
      return rawClient;
    },
    hotKv: new KvHttpClient({ accountId, apiToken, namespaceId: HOT_KV_NAMESPACE_ID }),
    groqApiKey,
    pexelsApiKey: optionalEnv("PEXELS_API_KEY"),
    discordWebhookUrl: optionalEnv("DISCORD_WEBHOOK_URL"),
  };
}
