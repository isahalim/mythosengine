import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "./apply-migrations.ts";
import { createTestDb } from "./client.ts";
import { runs } from "./schema.ts";
import { finishRun, reapStaleRuns, STALE_RUN_THRESHOLD_MS, startRun } from "./runs.ts";

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

  // Regression: GitHub Actions kills a job past its timeout-minutes with no
  // chance to run finishRun, so the row stays `running` forever and the
  // console reports it as the live stage. That is how the dashboard came to
  // show "Refreshing footage library" for hours after the job was dead.
  describe("reapStaleRuns", () => {
    const T0 = Date.parse("2026-08-29T00:00:00Z");

    it("closes a run left running past the threshold and says why", async () => {
      await startRun(ctx.db, "footage_refresh", "trace-abandoned", () => T0);
      const reaped = await reapStaleRuns(ctx.db, () => T0 + STALE_RUN_THRESHOLD_MS + 1);

      expect(reaped).toBe(1);
      const row = ctx.db.select().from(runs).all()[0];
      expect(row.status).toBe("failed");
      expect(row.finishedAt).not.toBeNull();
      // Recorded, not deleted: `runs` is the observability trail, and
      // "this was killed" is a real outcome the alert rules should see.
      expect(row.errorClass).toContain("abandoned");
    });

    it("leaves a genuinely in-flight run alone", async () => {
      await startRun(ctx.db, "render", "trace-live", () => T0);
      const reaped = await reapStaleRuns(ctx.db, () => T0 + 60_000);

      expect(reaped).toBe(0);
      expect(ctx.db.select().from(runs).all()[0].status).toBe("running");
    });

    it("does not touch runs that already finished, however old", async () => {
      const runId = await startRun(ctx.db, "watch", "trace-done", () => T0);
      await finishRun(ctx.db, runId, "succeeded", undefined, () => T0 + 1000);

      expect(await reapStaleRuns(ctx.db, () => T0 + 10 * STALE_RUN_THRESHOLD_MS)).toBe(0);
      const row = ctx.db.select().from(runs).all()[0];
      expect(row.status).toBe("succeeded");
      expect(row.errorClass).toBeNull();
    });

    it("is a no-op on an empty table", async () => {
      expect(await reapStaleRuns(ctx.db, () => T0)).toBe(0);
    });
  });
});
