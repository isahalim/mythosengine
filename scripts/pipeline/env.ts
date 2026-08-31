import { createD1HttpDb } from "../../db/d1-http.ts";
import { WorkerBatchClient } from "../../db/worker-batch.ts";
import type { AppDb, RawSqlClient } from "../../db/client.ts";
import { KvHttpClient } from "../../src/lib/drivers/kv-http.ts";

// Committed, non-secret resource ids (PROVISIONED.md / wrangler.toml — same
// values already public in that file, not something worth a GitHub Actions
// secret of its own).
const D1_DATABASE_ID = "77a0969e-2fb8-460e-9e52-f2606b2fa2fa";
export const HOT_KV_NAMESPACE_ID = "e1a2adff832742ae8953cab9905a7aa6";
/** PROVISIONED.md's "Live URL". Non-secret and already public in that file; overridable for a staging deploy. */
const DEFAULT_WORKER_URL = "https://mythosengine.5ryfrrjgmg.workers.dev";

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

export interface PipelineEnv {
  db: AppDb;
  rawClient: RawSqlClient;
  hotKv: KvHttpClient;
  accountId: string;
  apiToken: string;
  groqApiKey: string;
  discordWebhookUrl: string | undefined;
}

/** Every scripts/pipeline/*.ts entrypoint starts by building this — one place all the D1/KV-over-HTTP wiring lives. */
export function buildPipelineEnv(): PipelineEnv {
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

  return {
    db: createD1HttpDb(d1Options),
    get rawClient(): RawSqlClient {
      rawClient ??= new WorkerBatchClient({
        workerUrl: optionalEnv("WORKER_URL") ?? DEFAULT_WORKER_URL,
        token: requireEnv("PIPELINE_BATCH_TOKEN"),
      });
      return rawClient;
    },
    hotKv: new KvHttpClient({ accountId, apiToken, namespaceId: HOT_KV_NAMESPACE_ID }),
    accountId,
    apiToken,
    groqApiKey,
    discordWebhookUrl: optionalEnv("DISCORD_WEBHOOK_URL"),
  };
}
