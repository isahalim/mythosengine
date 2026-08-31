import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../../../db/apply-migrations.ts";
import { createTestDb } from "../../../db/client.ts";
import { signals, sources } from "../../../db/schema.ts";
import { SignalsBm25Retriever } from "./retriever.ts";

describe("SignalsBm25Retriever", () => {
  let ctx: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    ctx = createTestDb();
    applyMigrations(ctx.client);
    ctx.db
      .insert(sources)
      .values([
        { id: "reddit1", kind: "reddit", url: "https://reddit.com/r/games" },
        { id: "rss1", kind: "rss", url: "https://news.example.com/feed" },
      ])
      .run();
    ctx.db
      .insert(signals)
      .values([
        { id: "sig1", sourceId: "reddit1", canonicalUrl: "https://reddit.com/1", title: "GTA VI delayed to 2027, Rockstar confirms", observedAt: "2026-08-30T10:00:00Z", engagementScore: 9, simhash: "a", state: "scored" },
        { id: "sig2", sourceId: "rss1", canonicalUrl: "https://news.example.com/2", title: "Analysts cut Take-Two targets after the GTA delay", observedAt: "2026-08-30T09:00:00Z", engagementScore: 5, simhash: "b", state: "observed" },
        { id: "sig3", sourceId: "reddit1", canonicalUrl: "https://reddit.com/3", title: "Nintendo announces a new Zelda for Switch", observedAt: "2026-08-30T08:00:00Z", engagementScore: 4, simhash: "c", state: "observed" },
      ])
      .run();
  });

  afterEach(() => {
    ctx.client.close();
  });

  it("retrieves the signals that are actually about the query, ranked", async () => {
    const result = await new SignalsBm25Retriever(ctx.db).search("GTA delay", 5);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((p) => p.signalId)).toEqual(["sig1", "sig2"]);
    expect(result.value[0].score).toBeGreaterThan(0);
  });

  it("carries the provenance a citation needs", async () => {
    const result = await new SignalsBm25Retriever(ctx.db).search("Zelda", 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]).toMatchObject({
      signalId: "sig3",
      title: "Nintendo announces a new Zelda for Switch",
      url: "https://reddit.com/3",
      sourceKind: "reddit",
      observedAt: "2026-08-30T08:00:00Z",
    });
  });

  it("returns an empty list, not an error, when nothing matches", async () => {
    const result = await new SignalsBm25Retriever(ctx.db).search("quantum tunnelling in superconductors", 5);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });

  it("resolves a signal id to its provenance for the read-the-source tool", async () => {
    const result = await new SignalsBm25Retriever(ctx.db).get("sig2");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value?.url).toBe("https://news.example.com/2");
  });

  it("returns null for a signal id that isn't in the corpus", async () => {
    // The agent hallucinating an id has to be a typed miss, not a crash and
    // not a fetch of something arbitrary.
    const result = await new SignalsBm25Retriever(ctx.db).get("no-such-signal");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeNull();
  });

  it("indexes only the newest corpusLimit signals", async () => {
    const retriever = new SignalsBm25Retriever(ctx.db, 1);
    // sig1 is the most recently observed, so it is the only one indexed.
    const hit = await retriever.search("GTA delay", 5);
    expect(hit.ok && hit.value.map((p) => p.signalId)).toEqual(["sig1"]);
    const missed = await retriever.get("sig3");
    expect(missed.ok && missed.value).toBeNull();
  });

  it("works against an empty signals table", async () => {
    const empty = createTestDb();
    applyMigrations(empty.client);
    const result = await new SignalsBm25Retriever(empty.db).search("anything", 5);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
    empty.client.close();
  });
});
