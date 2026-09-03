import { describe, expect, it } from "vitest";
import { createTestDb } from "../../../db/client.ts";
import { applyMigrations } from "../../../db/apply-migrations.ts";
import { sources } from "../../../db/schema.ts";
import { ingestLatest, pickOnePerHost } from "./ideas-refresh.ts";

type SourceRow = typeof sources.$inferSelect;

/**
 * A `sources` row, with only the fields `pickOnePerHost` reads set to
 * anything meaningful. Built rather than inserted because the function under
 * test is pure — the rotation is the part that can be wrong in a way you
 * only notice as a stale screen, so it is tested without a database.
 */
function source(id: string, url: string, lastSeenAt: string | null): SourceRow {
  return { id, kind: "rss", url, enabled: 1, etag: null, lastModified: null, lastSeenAt } as SourceRow;
}

describe("pickOnePerHost", () => {
  it("spends one request on each host, whatever the source list looks like", () => {
    // Measured 2026-09-03: three concurrent reddit.com requests came back
    // 429/429/429 and a single one came back 200. Three reddit rows must
    // therefore cost one request, not three.
    const picked = pickOnePerHost([
      source("reddit-a", "https://www.reddit.com/r/AskReddit/rising.rss", "2026-09-03T03:00:00.000Z"),
      source("reddit-b", "https://www.reddit.com/r/AmItheAsshole/rising.rss", "2026-09-03T01:00:00.000Z"),
      source("reddit-c", "https://www.reddit.com/r/TrueOffMyChest/rising.rss", "2026-09-03T02:00:00.000Z"),
      source("bbc", "https://feeds.bbci.co.uk/news/rss.xml", "2026-09-03T03:00:00.000Z"),
      source("npr", "https://feeds.npr.org/1001/rss.xml", "2026-09-03T03:00:00.000Z"),
    ]);

    expect(picked).toHaveLength(3);
    expect(picked.map((s) => s.id).sort()).toEqual(["bbc", "npr", "reddit-b"]);
  });

  it("rotates: the least recently polled source in a host group wins", () => {
    // What makes one request per entry enough. Whichever subreddit is most
    // out of date is the one refreshed, so successive entries cover them all.
    const group = [
      source("reddit-a", "https://www.reddit.com/r/AskReddit/rising.rss", "2026-09-03T03:00:00.000Z"),
      source("reddit-b", "https://www.reddit.com/r/AmItheAsshole/rising.rss", "2026-09-03T01:00:00.000Z"),
      source("reddit-c", "https://www.reddit.com/r/TrueOffMyChest/rising.rss", "2026-09-03T02:00:00.000Z"),
    ];
    expect(pickOnePerHost(group)[0].id).toBe("reddit-b");

    // Once b has been polled it is the freshest, and c is now the stalest.
    const after = [source("reddit-b", group[1].url, "2026-09-03T04:00:00.000Z"), group[0], group[2]];
    expect(pickOnePerHost(after)[0].id).toBe("reddit-c");
  });

  it("polls a never-fetched source before any that has been", () => {
    const picked = pickOnePerHost([
      source("old", "https://www.reddit.com/r/AskReddit/rising.rss", "2026-09-03T03:00:00.000Z"),
      source("never", "https://www.reddit.com/r/NewOne/rising.rss", null),
    ]);
    expect(picked.map((s) => s.id)).toEqual(["never"]);
  });

  it("is stable when two sources in a group were polled at the same instant", () => {
    // Same `lastSeenAt` is ordinary — a batch update writes one timestamp to
    // every row it touched. Without the id tiebreak the pick would depend on
    // row order and the rotation could sit on one source forever.
    const rows = [
      source("reddit-z", "https://www.reddit.com/r/Z/rising.rss", "2026-09-03T03:00:00.000Z"),
      source("reddit-a", "https://www.reddit.com/r/A/rising.rss", "2026-09-03T03:00:00.000Z"),
    ];
    expect(pickOnePerHost(rows)[0].id).toBe("reddit-a");
    expect(pickOnePerHost([...rows].reverse())[0].id).toBe("reddit-a");
  });

  it("gives an unparseable URL its own budget rather than a shared one", () => {
    // The safe direction: a source that cannot be grouped is polled alone,
    // never silently folded into somebody else's rate limit.
    const picked = pickOnePerHost([source("broken", "not a url", null), source("bbc", "https://feeds.bbci.co.uk/news/rss.xml", null)]);
    expect(picked).toHaveLength(2);
  });
});

describe("ingestLatest", () => {
  it("reports a clean refresh over zero enabled sources rather than failing", async () => {
    const ctx = createTestDb();
    applyMigrations(ctx.client);

    const result = await ingestLatest(ctx.db, () => {});

    expect(result).toEqual({ sourcesFetched: 0, sourcesFailed: 0, newSignals: 0, degradedReason: null });
  });
});
