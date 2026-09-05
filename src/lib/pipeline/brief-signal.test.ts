import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../../../db/client.ts";
import { applyMigrations } from "../../../db/apply-migrations.ts";
import { signals, sources } from "../../../db/schema.ts";
import { queueRunPlan, claimNextRunPick } from "../../../db/run-picks.ts";
import { createOperatorSignal, ensureOperatorSource, operatorSignalUrl, OPERATOR_SOURCE_ID } from "./brief-signal.ts";

/**
 * The hinge the chat route turns on: a brief becomes a real `signals` row, and
 * every gate the rest of the pipeline puts in front of a signal accepts it.
 *
 * That last part is the point of the whole file, so it is tested against the
 * real `claimNextRunPick` and the real migrations rather than by asserting on
 * column values — the failure this guards against is not "the row looks
 * wrong", it is "the row looks fine and SCRIPT's foreign key rejects it".
 */
describe("createOperatorSignal", () => {
  let ctx: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    ctx = createTestDb();
    applyMigrations(ctx.client);
  });

  it("creates the operator source once and is idempotent", async () => {
    await ensureOperatorSource(ctx.db);
    await ensureOperatorSource(ctx.db);

    const rows = await ctx.db.select().from(sources).where(eq(sources.id, OPERATOR_SOURCE_ID)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("operator");
    // WATCH must never poll it: it has no feed behind it.
    expect(rows[0].enabled).toBe(0);
  });

  it("writes a signal that is already scored, so SCORE's duplicate clustering never sees it", async () => {
    const id = await createOperatorSignal(ctx.db, { briefId: "b1", title: "Why streaming prices all moved at once" });

    const row = (await ctx.db.select().from(signals).where(eq(signals.id, id)).all())[0];
    expect(row.state).toBe("scored");
    expect(row.sourceId).toBe(OPERATOR_SOURCE_ID);
    expect(row.canonicalUrl).toBe(operatorSignalUrl("b1"));
    // Computed the same way WATCH computes it, so this row is not a
    // differently-shaped citizen of the table it lives in.
    expect(row.simhash).toMatch(/^[0-9a-f]+$/);
  });

  it("gives two briefs distinct canonical URLs, which uq_signals_source_url requires", async () => {
    await createOperatorSignal(ctx.db, { briefId: "b1", title: "One" });
    await createOperatorSignal(ctx.db, { briefId: "b2", title: "Two" });

    const rows = await ctx.db.select().from(signals).all();
    expect(new Set(rows.map((r) => r.canonicalUrl)).size).toBe(2);
  });

  it("produces a signal a run pick can actually claim — the gate the whole design rests on", async () => {
    const signalId = await createOperatorSignal(ctx.db, { briefId: "b1", title: "Why streaming prices all moved at once" });
    const planId = await queueRunPlan(ctx.client, [{ topic: "tech", signalId }]);

    const claimed = await claimNextRunPick(ctx.db, "trace-1", new Date().toISOString(), planId);

    expect(claimed).not.toBeNull();
    expect(claimed?.signalId).toBe(signalId);
    // `claimedPick.topic` is what drives PLAN's prompt, SOURCE's topic-aware
    // download cap and EXPORT's hashtags — none of which needed a chat-route
    // special case precisely because this claim works unchanged.
    expect(claimed?.topic).toBe("tech");
  });

  it("is claimable only once, exactly as a brainstorm-route pick is", async () => {
    const signalId = await createOperatorSignal(ctx.db, { briefId: "b1", title: "A title" });
    const planId = await queueRunPlan(ctx.client, [{ topic: "ai", signalId }]);

    expect(await claimNextRunPick(ctx.db, "trace-1", new Date().toISOString(), planId)).not.toBeNull();
    expect(await claimNextRunPick(ctx.db, "trace-2", new Date().toISOString(), planId)).toBeNull();
  });
});
