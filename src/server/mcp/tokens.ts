import { eq } from "drizzle-orm";
import { getOne, type AppDb } from "../../../db/client.ts";
import { mcpTokens } from "../../../db/schema.ts";

// High-entropy random bearer tokens for external MCP clients (Claude
// Desktop, Claude Code) to authenticate to POST /console/mcp without a
// WebAuthn session. Hashed with SHA-256 (Web Crypto, no dependency) rather
// than Argon2id/PBKDF2 — these are 256-bit random values, not human
// passwords, so a slow password-hashing KDF buys nothing (same reasoning
// src/lib/vault.ts's fingerprintOf already applies to key fingerprints).
const TOKEN_PREFIX = "mcp_";

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `${TOKEN_PREFIX}${toHex(bytes)}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return toHex(new Uint8Array(digest));
}

export interface McpTokenSummary {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** Returns the plaintext token exactly once — only the hash is ever stored (CONSOLE_SPEC.md §2's "write-only" pattern, applied to a bearer token instead of a provider key). */
export async function issueMcpToken(db: AppDb, label: string, now: () => number = Date.now): Promise<{ token: string; summary: McpTokenSummary }> {
  const token = randomToken();
  const hash = await sha256Hex(token);
  const id = crypto.randomUUID();
  const createdAt = new Date(now()).toISOString();

  await db.insert(mcpTokens).values({ id, label, hash, createdAt, lastUsedAt: null, revokedAt: null }).run();

  return { token, summary: { id, label, createdAt, lastUsedAt: null, revokedAt: null } };
}

export async function listMcpTokens(db: AppDb): Promise<McpTokenSummary[]> {
  const rows = await db.select().from(mcpTokens).all();
  return rows.map(({ id, label, createdAt, lastUsedAt, revokedAt }) => ({ id, label, createdAt, lastUsedAt, revokedAt }));
}

export type RevokeMcpTokenResult = { kind: "ok" } | { kind: "not_found" };

export async function revokeMcpToken(db: AppDb, id: string, now: () => number = Date.now): Promise<RevokeMcpTokenResult> {
  const existing = await getOne(db.select().from(mcpTokens).where(eq(mcpTokens.id, id)));
  if (!existing || existing.revokedAt) return { kind: "not_found" };
  await db
    .update(mcpTokens)
    .set({ revokedAt: new Date(now()).toISOString() })
    .where(eq(mcpTokens.id, id))
    .run();
  return { kind: "ok" };
}

/** Hashes `candidate`, looks up a live (non-revoked) token, and bumps lastUsedAt. Returns the token's id, or null if unknown/revoked. */
export async function verifyMcpToken(db: AppDb, candidate: string, now: () => number = Date.now): Promise<string | null> {
  const hash = await sha256Hex(candidate);
  const row = await getOne(db.select().from(mcpTokens).where(eq(mcpTokens.hash, hash)));
  if (!row || row.revokedAt) return null;

  await db
    .update(mcpTokens)
    .set({ lastUsedAt: new Date(now()).toISOString() })
    .where(eq(mcpTokens.id, row.id))
    .run();

  return row.id;
}
