import { createD1HttpDb, D1HttpRawClient } from "../../db/d1-http.ts";
import type { AppDb, RawSqlClient } from "../../db/client.ts";
import { KvHttpClient } from "../../src/lib/drivers/kv-http.ts";

// Committed, non-secret resource ids (PROVISIONED.md / wrangler.toml — same
// values already public in that file, not something worth a GitHub Actions
// secret of its own).
const D1_DATABASE_ID = "77a0969e-2fb8-460e-9e52-f2606b2fa2fa";
export const HOT_KV_NAMESPACE_ID = "e1a2adff832742ae8953cab9905a7aa6";

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
  return {
    db: createD1HttpDb(d1Options),
    rawClient: new D1HttpRawClient(d1Options),
    hotKv: new KvHttpClient({ accountId, apiToken, namespaceId: HOT_KV_NAMESPACE_ID }),
    accountId,
    apiToken,
    groqApiKey,
    discordWebhookUrl: optionalEnv("DISCORD_WEBHOOK_URL"),
  };
}
