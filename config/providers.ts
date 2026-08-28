// config/providers.ts — the ONLY file that knows brand names (ARCHITECTURE.md §3).
// Business logic depends on the driver interfaces in src/lib/drivers/types.ts,
// never on a provider name directly.
//
// This is a function of an env-like record rather than a top-level constant
// because it runs in two different runtimes that don't share an env
// mechanism: the GitHub Actions pipeline runner (Node, `process.env`) and
// the Cloudflare Worker (the `env` object passed into `fetch`). Both call
// `resolveProviderConfig` with whichever env-like object they have.

export type EnvLike = Record<string, string | undefined>;

export const LLM_DRIVERS = ["groq", "workers-ai", "openai-compat"] as const;
export const ASR_DRIVERS = ["groq-whisper", "yt-captions", "none"] as const;
export const EMBED_DRIVERS = ["local-minilm", "workers-ai"] as const;
export const VECTOR_DRIVERS = ["sqlite-vec", "d1-hybrid"] as const;
export const CACHE_DRIVERS = ["kv", "memory"] as const;

export interface ProviderConfig {
  llm: (typeof LLM_DRIVERS)[number];
  asr: (typeof ASR_DRIVERS)[number];
  embed: (typeof EMBED_DRIVERS)[number];
  vector: (typeof VECTOR_DRIVERS)[number];
  cache: (typeof CACHE_DRIVERS)[number];
}

function pick<const T extends readonly string[]>(
  envValue: string | undefined,
  allowed: T,
  fallback: T[number],
): T[number] {
  if (envValue !== undefined && (allowed as readonly string[]).includes(envValue)) {
    return envValue as T[number];
  }
  return fallback;
}

/**
 * Default profile (profiles/free.env — the only profile that has to work):
 * LLM_DRIVER=groq, ASR_DRIVER=yt-captions, EMBED_DRIVER=local-minilm,
 * VECTOR_DRIVER=sqlite-vec, CACHE_DRIVER=kv. The fallback below is that
 * profile's default, not just the first entry in each driver list — those
 * lists are declared in a different order than the profile defaults them.
 */
export function resolveProviderConfig(env: EnvLike): ProviderConfig {
  return {
    llm: pick(env.LLM_DRIVER, LLM_DRIVERS, "groq"),
    asr: pick(env.ASR_DRIVER, ASR_DRIVERS, "yt-captions"),
    embed: pick(env.EMBED_DRIVER, EMBED_DRIVERS, "local-minilm"),
    vector: pick(env.VECTOR_DRIVER, VECTOR_DRIVERS, "sqlite-vec"),
    cache: pick(env.CACHE_DRIVER, CACHE_DRIVERS, "kv"),
  };
}
