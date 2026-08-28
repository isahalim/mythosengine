import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../../db/client.ts";
import { applyMigrations } from "../../../db/apply-migrations.ts";
import { issueMcpToken, listMcpTokens, revokeMcpToken, verifyMcpToken } from "./tokens.ts";

describe("mcp tokens", () => {
  let ctx: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    ctx = createTestDb();
    applyMigrations(ctx.client);
  });

  it("issues a token that verifies, and never stores the plaintext", async () => {
    const { token, summary } = await issueMcpToken(ctx.db, "Claude Desktop");
    expect(token.startsWith("mcp_")).toBe(true);

    const verifiedId = await verifyMcpToken(ctx.db, token);
    expect(verifiedId).toBe(summary.id);

    const [row] = await listMcpTokens(ctx.db);
    expect(row.label).toBe("Claude Desktop");
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it("rejects an unknown token", async () => {
    await issueMcpToken(ctx.db, "Claude Desktop");
    expect(await verifyMcpToken(ctx.db, "mcp_not-a-real-token")).toBeNull();
  });

  it("bumps lastUsedAt on a successful verify", async () => {
    const { token } = await issueMcpToken(ctx.db, "Claude Desktop", () => 1000);
    expect((await listMcpTokens(ctx.db))[0].lastUsedAt).toBeNull();

    await verifyMcpToken(ctx.db, token, () => 2000);
    expect((await listMcpTokens(ctx.db))[0].lastUsedAt).toBe(new Date(2000).toISOString());
  });

  it("rejects a revoked token on its very next call", async () => {
    const { token, summary } = await issueMcpToken(ctx.db, "Claude Desktop");
    expect(await verifyMcpToken(ctx.db, token)).toBe(summary.id);

    const revoked = await revokeMcpToken(ctx.db, summary.id);
    expect(revoked.kind).toBe("ok");
    expect(await verifyMcpToken(ctx.db, token)).toBeNull();
  });

  it("revoking twice, or an unknown id, reports not_found", async () => {
    const { summary } = await issueMcpToken(ctx.db, "Claude Desktop");
    expect((await revokeMcpToken(ctx.db, summary.id)).kind).toBe("ok");
    expect((await revokeMcpToken(ctx.db, summary.id)).kind).toBe("not_found");
    expect((await revokeMcpToken(ctx.db, "nonexistent")).kind).toBe("not_found");
  });
});
