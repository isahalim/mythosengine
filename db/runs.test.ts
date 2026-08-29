import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "./apply-migrations.ts";
import { createTestDb } from "./client.ts";
import { runs } from "./schema.ts";
import { finishRun, startRun } from "./runs.ts";

describe("startRun / finishRun", () => {
  let ctx: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    ctx = createTestDb();
    applyMigrations(ctx.client);
  });

  afterEach(() => {
    ctx.client.close();
  });

  it("starts a run in the running state with no finishedAt", async () => {
    const runId = await startRun(ctx.db, "watch", "trace-1", () => Date.parse("2026-08-28T00:00:00Z"));
    const row = ctx.db.select().from(runs).where(eq(runs.id, runId)).get();
    expect(row?.status).toBe("running");
    expect(row?.finishedAt).toBeNull();
    expect(row?.stage).toBe("watch");
  });

  it("finishRun records the completion status and finishedAt", async () => {
    const runId = await startRun(ctx.db, "tts", "trace-2", () => Date.parse("2026-08-28T00:00:00Z"));
    await finishRun(ctx.db, runId, "failed", "provider_error", () => Date.parse("2026-08-28T00:05:00Z"));

    const row = ctx.db.select().from(runs).where(eq(runs.id, runId)).get();
    expect(row?.status).toBe("failed");
    expect(row?.errorClass).toBe("provider_error");
    expect(row?.finishedAt).toBe("2026-08-28T00:05:00.000Z");
  });

  it("consecutive failed runs for the same stage are exactly what checkAndAlert's stage_failing rule scans for", async () => {
    for (let i = 0; i < 3; i++) {
      const runId = await startRun(ctx.db, "render", `trace-${i}`, () => Date.parse("2026-08-28T00:00:00Z"));
      await finishRun(ctx.db, runId, "failed");
    }
    const rows = ctx.db.select().from(runs).all();
    expect(rows.filter((r) => r.stage === "render" && r.status === "failed")).toHaveLength(3);
  });
});
