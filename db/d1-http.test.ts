import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createD1HttpDb, D1HttpRawClient } from "./d1-http.ts";
import { execAtomic } from "./client.ts";
import { sources } from "./schema.ts";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/** Same shape as src/lib/drivers/driver-contract.test.ts's startMockServer, standing in for Cloudflare's D1 REST API. */
function startMockServer(): { server: Server; baseUrl: Promise<string>; queue: (handler: Handler) => void; requests: { sql: string; params: unknown[] }[] } {
  const handlers: Handler[] = [];
  const requests: { sql: string; params: unknown[] }[] = [];

  const defaultHandler: Handler = (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: true, errors: [], messages: [], result: [{ success: true, results: [] }] }));
  };

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      const parsed = JSON.parse(body) as { sql: string; params: unknown[] };
      requests.push(parsed);
      const handler = handlers.shift() ?? defaultHandler;
      handler(req, res);
    });
  });

  const baseUrl = new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("expected a network address");
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });

  return { server, baseUrl, queue: (h) => handlers.push(h), requests };
}

function jsonResult(results: Record<string, unknown>[]): Handler {
  return (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: true, errors: [], messages: [], result: [{ success: true, results }] }));
  };
}

describe("createD1HttpDb", () => {
  let mock: ReturnType<typeof startMockServer>;

  beforeEach(() => {
    mock = startMockServer();
  });

  afterEach(() => {
    mock.server.close();
  });

  it("selects rows, converting D1's column-keyed objects to drizzle's expected shape", async () => {
    mock.queue(jsonResult([{ id: "src-1", kind: "rss", url: "https://example.com/feed", enabled: 1, last_seen_at: null, etag: null, last_modified: null }]));
    const db = createD1HttpDb({ accountId: "acct", databaseId: "db", apiToken: "token", baseUrl: await mock.baseUrl, maxAttempts: 1, timeoutMs: 2000 });

    const rows = await db.select().from(sources).all();
    expect(rows).toEqual([{ id: "src-1", kind: "rss", url: "https://example.com/feed", enabled: 1, lastSeenAt: null, etag: null, lastModified: null }]);
  });

  it("gets a single row without an extra array wrapper", async () => {
    mock.queue(jsonResult([{ id: "src-1", kind: "rss", url: "https://example.com/feed", enabled: 1, last_seen_at: null, etag: null, last_modified: null }]));
    const db = createD1HttpDb({ accountId: "acct", databaseId: "db", apiToken: "token", baseUrl: await mock.baseUrl, maxAttempts: 1, timeoutMs: 2000 });

    const row = await db.select().from(sources).where(eq(sources.id, "src-1")).get();
    expect(row?.id).toBe("src-1");
  });

  it("sends the real sql/params body Cloudflare's D1 REST API expects", async () => {
    mock.queue(jsonResult([]));
    const db = createD1HttpDb({ accountId: "acct", databaseId: "db", apiToken: "token", baseUrl: await mock.baseUrl, maxAttempts: 1, timeoutMs: 2000 });

    await db.insert(sources).values({ id: "src-2", kind: "rss", url: "https://example.com/feed2", enabled: 1 }).run();
    expect(mock.requests[0].sql).toMatch(/insert into/i);
    expect(mock.requests[0].params).toContain("src-2");
  });

  it("throws when Cloudflare's envelope reports success: false", async () => {
    mock.queue((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: false, errors: [{ code: 7500, message: "no such table" }], messages: [] }));
    });
    const db = createD1HttpDb({ accountId: "acct", databaseId: "db", apiToken: "token", baseUrl: await mock.baseUrl, maxAttempts: 1, timeoutMs: 2000 });

    // sqlite-proxy wraps the thrown error as DrizzleQueryError, preserving ours on `.cause`.
    await expect(db.select().from(sources).all()).rejects.toMatchObject({ cause: { message: expect.stringContaining("no such table") } });
  });
});

describe("D1HttpRawClient (execAtomic's HTTP arm)", () => {
  let mock: ReturnType<typeof startMockServer>;

  beforeEach(() => {
    mock = startMockServer();
  });

  afterEach(() => {
    mock.server.close();
  });

  it("wraps multiple statements in one BEGIN/COMMIT call with globally renumbered placeholders", async () => {
    mock.queue(jsonResult([]));
    const client = new D1HttpRawClient({ accountId: "acct", databaseId: "db", apiToken: "token", baseUrl: await mock.baseUrl, maxAttempts: 1, timeoutMs: 2000 });

    await execAtomic(client, [
      { sql: "UPDATE sources SET enabled = ? WHERE id = ?", params: [0, "src-1"] },
      { sql: "INSERT INTO sources (id, kind, url) VALUES (?, ?, ?)", params: ["src-2", "rss", "https://example.com"] },
    ]);

    expect(mock.requests).toHaveLength(1);
    const { sql, params } = mock.requests[0];
    expect(sql).toMatch(/^BEGIN;/);
    expect(sql).toMatch(/COMMIT;$/);
    expect(sql).toContain("?1");
    expect(sql).toContain("?5");
    expect(params).toEqual([0, "src-1", "src-2", "rss", "https://example.com"]);
  });
});
