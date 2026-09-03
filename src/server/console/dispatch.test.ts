import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../../db/client.ts";
import { applyMigrations } from "../../../db/apply-migrations.ts";
import { dispatchRun, DISPATCH_NOT_TRIGGERED_NOTE } from "./dispatch.ts";
import { GithubActionsDriver } from "../../lib/drivers/github-actions.ts";
import { setPipelineEnabled } from "./killswitch.ts";
import { runs, signals, sources } from "../../../db/schema.ts";
import { queueRunPlan } from "../../../db/run-picks.ts";

/**
 * A GithubActionsDriver over a fetch that answers as GitHub does (204, no
 * body) and records what it was asked to start — the same driver the Worker
 * uses, not a stand-in for it, so these tests exercise the real request
 * shaping.
 */
function fakeActions(status = 204): { driver: GithubActionsDriver; calls: { url: string; body: unknown }[] } {
  const calls: { url: string; body: unknown }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response(status === 204 ? null : "denied", { status });
  }) as unknown as typeof fetch;
  return { driver: new GithubActionsDriver("tok", "o/r", { fetchImpl }), calls };
}

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

  it("with no dispatch credential, records the run and says outright that nothing was triggered", async () => {
    const result = await dispatchRun(ctx.db, kv);

    expect(result).toMatchObject({ kind: "queued", note: DISPATCH_NOT_TRIGGERED_NOTE });
    const rows = await ctx.db.select().from(runs).all();
    // Left `queued`: src/server/console/runs.ts reads exactly that to
    // report the run as `not_triggered`.
    expect(rows[0]).toMatchObject({ stage: "dispatch", status: "queued", finishedAt: null });
  });

  it("hands the workflow the trace it just recorded, so the console and the pipeline share one run id", async () => {
    const { driver, calls } = fakeActions();

    const result = await dispatchRun(ctx.db, kv, { actions: driver });

    expect(result.kind).toBe("queued");
    if (result.kind !== "queued") return;
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/actions/workflows/render.yml/dispatches");
    expect(calls[0].body).toMatchObject({ ref: "main", inputs: { trace_id: result.runId } });
    expect(result.note).toBeNull();
  });

  it("tells the workflow how many videos to make, from the picks actually queued", async () => {
    await ctx.db.insert(sources).values({ id: "src1", kind: "reddit", url: "http://x" }).run();
    await ctx.db
      .insert(signals)
      .values(
        ["a", "b", "c"].map((id) => ({
          id,
          sourceId: "src1",
          canonicalUrl: `http://x/${id}`,
          title: `Headline ${id}`,
          observedAt: "2026-08-31T00:00:00.000Z",
          engagementScore: 1,
          simhash: id,
          state: "scored" as const,
        })),
      )
      .run();
    await queueRunPlan(ctx.client, [
      { topic: "ai", signalId: "a" },
      { topic: "tech", signalId: "b" },
      { topic: "viral", signalId: "c" },
    ]);

    const { driver, calls } = fakeActions();
    await dispatchRun(ctx.db, kv, { actions: driver });

    expect((calls[0].body as { inputs: { count: string } }).inputs.count).toBe("3");
  });

  it("binds the run to the plan just submitted, and sizes it to that plan alone", async () => {
    // Operator direction 2026-09-03: a run makes the plan the operator just
    // submitted and nothing else, so an older queued pick can never take its
    // slot or its tokens.
    await ctx.db.insert(sources).values({ id: "src1", kind: "reddit", url: "http://x" }).run();
    await ctx.db
      .insert(signals)
      .values(
        ["stale", "fresh"].map((id) => ({
          id,
          sourceId: "src1",
          canonicalUrl: `http://x/${id}`,
          title: `Headline ${id}`,
          observedAt: "2026-08-31T00:00:00.000Z",
          engagementScore: 1,
          simhash: id,
          state: "scored" as const,
        })),
      )
      .run();
    await queueRunPlan(ctx.client, [{ topic: "politics", signalId: "stale" }], () => Date.parse("2026-09-03T07:02:30.489Z"));
    const freshPlan = await queueRunPlan(ctx.client, [{ topic: "tech", signalId: "fresh" }], () => Date.parse("2026-09-03T20:14:44.438Z"));

    const { driver, calls } = fakeActions();
    await dispatchRun(ctx.db, kv, { actions: driver });

    const inputs = (calls[0].body as { inputs: { count: string; plan_id: string } }).inputs;
    expect(inputs.plan_id).toBe(freshPlan);
    expect(inputs.count).toBe("1");
  });

  it("dispatches one unscoped render with an empty queue — RENDER falls back to the diversity weighting", async () => {
    const { driver, calls } = fakeActions();

    await dispatchRun(ctx.db, kv, { actions: driver });

    const inputs = (calls[0].body as { inputs: { count: string; plan_id: string } }).inputs;
    expect(inputs.count).toBe("1");
    expect(inputs.plan_id).toBe("");
  });

  it("closes the dispatch row as succeeded once GitHub accepts it, so the reaper never marks it abandoned", async () => {
    const { driver } = fakeActions();

    await dispatchRun(ctx.db, kv, { actions: driver });

    const rows = await ctx.db.select().from(runs).all();
    expect(rows[0].status).toBe("succeeded");
    expect(rows[0].finishedAt).not.toBeNull();
  });

  it("records a failed trigger as failed, with the provider's own reason — never as a started run", async () => {
    const { driver } = fakeActions(403);

    const result = await dispatchRun(ctx.db, kv, { actions: driver });

    expect(result.kind).toBe("queued");
    if (result.kind !== "queued") return;
    expect(result.note).toContain("could not be started");
    const rows = await ctx.db.select().from(runs).all();
    expect(rows[0].status).toBe("failed");
    expect(rows[0].errorClass).toContain("dispatch_failed:");
  });

  it("honours a non-default workflow and ref", async () => {
    const { driver, calls } = fakeActions();

    await dispatchRun(ctx.db, kv, { actions: driver, workflow: "other.yml", ref: "staging" });

    expect(calls[0].url).toContain("/workflows/other.yml/dispatches");
    expect(calls[0].body).toMatchObject({ ref: "staging" });
  });

  it("rate-limits to 10 dispatches per rolling hour", async () => {
    let now = 0;
    for (let i = 0; i < 10; i++) {
      const result = await dispatchRun(ctx.db, kv, { now: () => now });
      expect(result.kind).toBe("queued");
      now += 1000;
    }
    const eleventh = await dispatchRun(ctx.db, kv, { now: () => now });
    expect(eleventh.kind).toBe("rate_limited");
  });

  it("allows a new dispatch once the oldest one falls outside the rolling hour", async () => {
    let now = 0;
    for (let i = 0; i < 10; i++) {
      await dispatchRun(ctx.db, kv, { now: () => now });
      now += 1000;
    }
    now += 61 * 60 * 1000; // past the 1-hour window for all 10 prior dispatches
    const result = await dispatchRun(ctx.db, kv, { now: () => now });
    expect(result.kind).toBe("queued");
  });
});
