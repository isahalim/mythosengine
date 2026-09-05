import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../../../db/client.ts";
import { applyMigrations } from "../../../db/apply-migrations.ts";
import { runs } from "../../../db/schema.ts";
import { getBrief, listBriefAttachments } from "../../../db/briefs.ts";
import { GithubActionsDriver } from "../../lib/drivers/github-actions.ts";
import { setPipelineEnabled } from "./killswitch.ts";
import { getBriefView, listBriefViews, submitBrief, MAX_BRIEF_ATTACHMENTS, MAX_BRIEF_ATTACHMENT_BYTES, MAX_BRIEF_PROMPT_CHARS, type BriefAttachmentInput } from "./briefs.ts";

/** The real driver over a fetch that answers as GitHub does, recording what it was asked to start. */
function fakeActions(status = 204): { driver: GithubActionsDriver; calls: { body: { inputs?: Record<string, string> } }[] } {
  const calls: { body: { inputs?: Record<string, string> } }[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    calls.push({ body: JSON.parse(String(init?.body)) as { inputs?: Record<string, string> } });
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

/** The slice of R2 this endpoint uses, recording what it was handed. */
function fakeBucket(): { bucket: R2Bucket; puts: string[] } {
  const puts: string[] = [];
  const bucket = {
    put: (key: string) => {
      puts.push(key);
      return Promise.resolve({ size: 1 });
    },
  } as unknown as R2Bucket;
  return { bucket, puts };
}

function textAttachment(filename: string, body = "hello", mimeType = "text/plain"): BriefAttachmentInput {
  return { filename, mimeType, bytes: new TextEncoder().encode(body) as Uint8Array<ArrayBuffer> };
}

describe("submitBrief", () => {
  let ctx: ReturnType<typeof createTestDb>;
  let kv: FakeKv;

  beforeEach(async () => {
    ctx = createTestDb();
    applyMigrations(ctx.client);
    kv = new FakeKv();
    await setPipelineEnabled(kv, true);
  });

  it("stores the prompt verbatim and dispatches a brief-scoped run of exactly one video", async () => {
    const { driver, calls } = fakeActions();
    const result = await submitBrief("Why streaming prices all moved at once", [], { db: ctx.db, killswitchKv: kv, exportBucket: undefined, actions: driver });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.brief.prompt).toBe("Why streaming prices all moved at once");

    // A brief is one idea and makes one video; `plan_id` is empty because
    // this run queues its own plan on the runner, once DIGEST knows what it
    // is building.
    expect(calls[0].body.inputs).toMatchObject({ count: "1", plan_id: "", brief_id: result.brief.id });
    expect(calls[0].body.inputs?.trace_id).toBe(result.brief.traceId);
  });

  it("writes the trace before dispatching, so the chat surface polls the run the pipeline writes to", async () => {
    const { driver } = fakeActions();
    const result = await submitBrief("A specific idea about streaming prices", [], { db: ctx.db, killswitchKv: kv, exportBucket: undefined, actions: driver });
    if (result.kind !== "ok") throw new Error("expected ok");

    const row = (await ctx.db.select().from(runs).where(eq(runs.id, result.brief.traceId ?? "")).all())[0];
    expect(row).toBeDefined();
    expect(row.status).toBe("succeeded");
  });

  it("puts every attachment in R2 under its derived key, and records a row for each", async () => {
    const { driver } = fakeActions();
    const { bucket, puts } = fakeBucket();
    const result = await submitBrief("An idea with notes attached to it", [textAttachment("a.txt"), textAttachment("b.md", "x", "text/markdown")], {
      db: ctx.db,
      killswitchKv: kv,
      exportBucket: bucket,
      actions: driver,
    });
    if (result.kind !== "ok") throw new Error("expected ok");

    expect(puts).toEqual([`briefs/${result.brief.id}/0`, `briefs/${result.brief.id}/1`]);
    const rows = await listBriefAttachments(ctx.db, result.brief.id);
    expect(rows.map((r) => r.filename)).toEqual(["a.txt", "b.md"]);
  });

  it("refuses attachments when this Worker has no bucket, rather than losing them silently", async () => {
    const { driver } = fakeActions();
    const result = await submitBrief("An idea", [textAttachment("a.txt")], { db: ctx.db, killswitchKv: kv, exportBucket: undefined, actions: driver });

    expect(result.kind).toBe("no_blob_store");
  });

  it("validates before it writes anything", async () => {
    const { driver, calls } = fakeActions();
    const deps = { db: ctx.db, killswitchKv: kv, exportBucket: fakeBucket().bucket, actions: driver };

    const cases: [BriefAttachmentInput[], string, string][] = [
      [[], "   ", "needs a prompt"],
      [[], "x".repeat(MAX_BRIEF_PROMPT_CHARS + 1), "capped at"],
      [Array.from({ length: MAX_BRIEF_ATTACHMENTS + 1 }, (_, i) => textAttachment(`f${i}.txt`)), "an idea", "at most"],
      [[{ filename: "a.zip", mimeType: "application/zip", bytes: new Uint8Array([1]) as Uint8Array<ArrayBuffer> }], "an idea", "digest cannot read"],
      [[{ filename: "big.txt", mimeType: "text/plain", bytes: new Uint8Array(MAX_BRIEF_ATTACHMENT_BYTES + 1) as Uint8Array<ArrayBuffer> }], "an idea", "capped at"],
    ];

    for (const [files, prompt, expected] of cases) {
      const result = await submitBrief(prompt, files, deps);
      expect(result.kind).toBe("invalid");
      if (result.kind !== "invalid") continue;
      expect(result.message).toContain(expected);
    }

    expect(calls).toHaveLength(0);
    expect(await listBriefViews(ctx.db)).toEqual([]);
  });

  it("refuses while the killswitch is off", async () => {
    await setPipelineEnabled(kv, false);
    const { driver } = fakeActions();
    const result = await submitBrief("An idea about streaming prices", [], { db: ctx.db, killswitchKv: kv, exportBucket: undefined, actions: driver });

    expect(result.kind).toBe("disabled");
  });

  it("shares the dispatch route's hourly budget rather than doubling it", async () => {
    const { driver } = fakeActions();
    const deps = { db: ctx.db, killswitchKv: kv, exportBucket: undefined, actions: driver };

    for (let i = 0; i < 10; i++) {
      expect((await submitBrief(`Idea number ${i} about streaming prices`, [], deps)).kind).toBe("ok");
    }
    expect((await submitBrief("One too many ideas about streaming", [], deps)).kind).toBe("rate_limited");
  });

  it("records a real brief with no dispatch credential, and says nothing was started", async () => {
    const result = await submitBrief("An idea about streaming prices", [], { db: ctx.db, killswitchKv: kv, exportBucket: undefined, actions: null });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.note).toContain("not actually triggered");
    expect(await getBrief(ctx.db, result.brief.id)).not.toBeNull();
  });

  it("marks the brief failed with the reason when the workflow could not be started", async () => {
    const { driver } = fakeActions(403);
    const result = await submitBrief("An idea about streaming prices", [], { db: ctx.db, killswitchKv: kv, exportBucket: undefined, actions: driver });
    if (result.kind !== "ok") throw new Error("expected ok");

    const stored = await getBrief(ctx.db, result.brief.id);
    expect(stored?.status).toBe("failed");
    // The operator is looking at the chat transcript, not the run view.
    expect(stored?.failureReason).toContain("could not be started");
  });
});

describe("listBriefViews / getBriefView", () => {
  let ctx: ReturnType<typeof createTestDb>;
  let kv: FakeKv;

  beforeEach(async () => {
    ctx = createTestDb();
    applyMigrations(ctx.client);
    kv = new FakeKv();
    await setPipelineEnabled(kv, true);
  });

  it("lists newest first, with each brief's attachment filenames", async () => {
    const { driver } = fakeActions();
    const { bucket } = fakeBucket();
    const deps = { db: ctx.db, killswitchKv: kv, exportBucket: bucket, actions: driver };

    const first = await submitBrief("The first idea about streaming", [textAttachment("a.txt")], { ...deps, now: () => 1_000 });
    const second = await submitBrief("The second idea about streaming", [], { ...deps, now: () => 2_000 });
    if (first.kind !== "ok" || second.kind !== "ok") throw new Error("expected ok");

    const list = await listBriefViews(ctx.db);
    expect(list.map((b) => b.id)).toEqual([second.brief.id, first.brief.id]);
    expect(list[1].attachments).toEqual([{ filename: "a.txt", mimeType: "text/plain", sizeBytes: 5 }]);
  });

  it("returns null for a brief that does not exist, never a truthy row of undefined fields", async () => {
    expect(await getBriefView(ctx.db, "nope")).toBeNull();
  });
});
