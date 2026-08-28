import type { KvLike } from "../../lib/drivers/cache-kv.ts";

const KILLSWITCH_KEY = "PIPELINE_ENABLED";

/** `PIPELINE_ENABLED` in KV (AGENT_PLAYBOOK.md Part IV) — checked at the top of every run. */
export async function isPipelineEnabled(kv: KvLike): Promise<boolean> {
  const value = await kv.get(KILLSWITCH_KEY);
  return value !== "false"; // enabled by default until explicitly switched off
}

export async function setPipelineEnabled(kv: KvLike, enabled: boolean): Promise<void> {
  await kv.put(KILLSWITCH_KEY, enabled ? "true" : "false");
}
