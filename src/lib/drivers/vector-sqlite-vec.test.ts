import { describe, expect, it } from "vitest";
import { SqliteVecVectorDriver } from "./vector-sqlite-vec.ts";

describe("SqliteVecVectorDriver (stub)", () => {
  it("upsert always returns a typed not_implemented error", async () => {
    const result = await new SqliteVecVectorDriver().upsert([{ id: "1", vector: [0.1], metadata: {} }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("not_implemented");
  });

  it("query always returns a typed not_implemented error", async () => {
    const result = await new SqliteVecVectorDriver().query({ vector: [0.1], topK: 5 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("not_implemented");
  });
});
