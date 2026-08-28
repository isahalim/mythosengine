import { describe, expect, it } from "vitest";
import { LocalMinilmEmbedDriver } from "./embed-local-minilm.ts";

describe("LocalMinilmEmbedDriver (stub)", () => {
  it("always returns a typed not_implemented error, never a fake embedding", async () => {
    const result = await new LocalMinilmEmbedDriver().embed({ texts: ["hello"] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("not_implemented");
      expect(result.error.retryable).toBe(false);
    }
  });
});
