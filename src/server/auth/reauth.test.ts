import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../../db/client.ts";
import { applyMigrations } from "../../../db/apply-migrations.ts";
import { consumeReauthNonce, issueReauthNonce } from "./reauth.ts";

describe("reauth nonce", () => {
  let ctx: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    ctx = createTestDb();
    applyMigrations(ctx.client);
  });

  it("consumes a freshly-issued nonce exactly once", async () => {
    const nonce = await issueReauthNonce(ctx.db, "session-1");
    expect(await consumeReauthNonce(ctx.db, nonce, "session-1")).toBe(true);
    expect(await consumeReauthNonce(ctx.db, nonce, "session-1")).toBe(false);
  });

  it("refuses a nonce issued to a different session", async () => {
    const nonce = await issueReauthNonce(ctx.db, "session-1");
    expect(await consumeReauthNonce(ctx.db, nonce, "session-2")).toBe(false);
  });

  it("refuses an expired nonce", async () => {
    let now = 0;
    const nonce = await issueReauthNonce(ctx.db, "session-1", () => now);
    now = 6 * 60 * 1000; // past the 5-minute TTL
    expect(await consumeReauthNonce(ctx.db, nonce, "session-1", () => now)).toBe(false);
  });

  it("refuses an unknown nonce", async () => {
    expect(await consumeReauthNonce(ctx.db, "not-a-real-nonce", "session-1")).toBe(false);
  });
});
