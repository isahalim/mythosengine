import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../../db/client.ts";
import { applyMigrations } from "../../../db/apply-migrations.ts";
import { dispatchRun } from "./dispatch.ts";
import { setPipelineEnabled } from "./killswitch.ts";
import { runs } from "../../../db/schema.ts";

class FakeKv {
  private readonly store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
}

describe("dispatchRun", () => {
  let ctx: ReturnType<typeof createTestDb>;
  let kv: FakeKv;

  beforeEach(() => {
    ctx = createTestDb();
    applyMigrations(ctx.client);
    kv = new FakeKv();
  });

  it("refuses to dispatch when the killswitch is off, but still records the attempt (CONSOLE_SPEC.md §6 acceptance test 6)", async () => {
    await setPipelineEnabled(kv, false);
    const result = await dispatchRun(ctx.db, kv);
    expect(result).toEqual({ kind: "disabled" });

    const rows = await ctx.db.select().from(runs).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "skipped", errorClass: "pipeline_disabled" });
  });

  it("queues a run and records it for observability", async () => {
    const result = await dispatchRun(ctx.db, kv);
    expect(result.kind).toBe("queued");
  });

  it("rate-limits to 10 dispatches per rolling hour", async () => {
    let now = 0;
    for (let i = 0; i < 10; i++) {
      const result = await dispatchRun(ctx.db, kv, () => now);
      expect(result.kind).toBe("queued");
      now += 1000;
    }
    const eleventh = await dispatchRun(ctx.db, kv, () => now);
    expect(eleventh.kind).toBe("rate_limited");
  });

  it("allows a new dispatch once the oldest one falls outside the rolling hour", async () => {
    let now = 0;
    for (let i = 0; i < 10; i++) {
      await dispatchRun(ctx.db, kv, () => now);
      now += 1000;
    }
    now += 61 * 60 * 1000; // past the 1-hour window for all 10 prior dispatches
    const result = await dispatchRun(ctx.db, kv, () => now);
    expect(result.kind).toBe("queued");
  });
});
