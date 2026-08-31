import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerBatchClient } from "./worker-batch.ts";

interface MockWorker {
  url: string;
  received: { authorization: string | undefined; body: unknown }[];
  close: () => Promise<void>;
}

/**
 * Stands in for the deployed Worker. The contract this client depends on is
 * small — a bearer header, a JSON body, and an HTTP status whose error text
 * is worth keeping — so it is worth testing against a real socket rather
 * than a stubbed `fetch`: the timeout, the header and the body encoding all
 * only exist over a real connection.
 */
async function startMockWorker(handler: (received: number) => { status: number; body: string; delayMs?: number }): Promise<MockWorker> {
  const received: MockWorker["received"] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      received.push({ authorization: req.headers.authorization, body: JSON.parse(raw) as unknown });
      const { status, body, delayMs } = handler(received.length);
      setTimeout(() => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(body);
      }, delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("mock worker did not bind a port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let mock: MockWorker | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

describe("WorkerBatchClient", () => {
  it("posts the statements to /internal/d1/batch with the bearer token", async () => {
    mock = await startMockWorker(() => ({ status: 200, body: JSON.stringify({ ok: true, statements: 1 }) }));
    const client = new WorkerBatchClient({ workerUrl: mock.url, token: "pbt_secret" });

    await client.batch([{ sql: "update runs set status = ?", params: ["succeeded"] }]);

    expect(mock.received).toHaveLength(1);
    expect(mock.received[0].authorization).toBe("Bearer pbt_secret");
    expect(mock.received[0].body).toEqual({ statements: [{ sql: "update runs set status = ?", params: ["succeeded"] }] });
  });

  it("keeps the Worker's explanation of a rejection instead of discarding it", async () => {
    mock = await startMockWorker(() => ({ status: 500, body: JSON.stringify({ error: "batch_failed", detail: "no such table: widgets" }) }));
    const client = new WorkerBatchClient({ workerUrl: mock.url, token: "t" });

    // A pipeline run's only evidence is its CI log. A batch that fails
    // without saying why is the exact failure mode this project has lost
    // days to; the database's own words have to survive the trip.
    await expect(client.batch([{ sql: "select 1", params: [] }])).rejects.toThrow(/no such table: widgets/);
  });

  it("names the HTTP status so an auth failure is not mistaken for a SQL failure", async () => {
    mock = await startMockWorker(() => ({ status: 401, body: JSON.stringify({ error: "unauthorized" }) }));
    const client = new WorkerBatchClient({ workerUrl: mock.url, token: "wrong" });
    await expect(client.batch([{ sql: "select 1", params: [] }])).rejects.toThrow(/HTTP 401/);
  });

  it("gives up rather than hanging when the Worker never answers", async () => {
    mock = await startMockWorker(() => ({ status: 200, body: "{}", delayMs: 2_000 }));
    const client = new WorkerBatchClient({ workerUrl: mock.url, token: "t", timeoutMs: 100 });
    await expect(client.batch([{ sql: "select 1", params: [] }])).rejects.toThrow(/could not reach the Worker/);
  });

  it("says which host it could not reach when the Worker is down", async () => {
    // Port 1 is reserved and nothing listens on it.
    const client = new WorkerBatchClient({ workerUrl: "http://127.0.0.1:1", token: "t", timeoutMs: 2_000 });
    await expect(client.batch([{ sql: "select 1", params: [] }])).rejects.toThrow(/127\.0\.0\.1:1/);
  });
});
