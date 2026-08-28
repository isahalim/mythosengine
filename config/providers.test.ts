import { describe, expect, it } from "vitest";
import { resolveProviderConfig } from "./providers.ts";

describe("resolveProviderConfig", () => {
  it("defaults to the free profile when env is empty", () => {
    expect(resolveProviderConfig({})).toEqual({
      llm: "groq",
      asr: "yt-captions",
      embed: "local-minilm",
      vector: "sqlite-vec",
      cache: "kv",
      export: "kv-blob",
    });
  });

  it("honors an explicit valid override", () => {
    expect(resolveProviderConfig({ CACHE_DRIVER: "memory" }).cache).toBe("memory");
  });

  it("falls back to the default on an unrecognized value instead of throwing", () => {
    expect(resolveProviderConfig({ LLM_DRIVER: "chatgpt-4o-ultra" }).llm).toBe("groq");
  });
});
