import { sql } from "drizzle-orm";
import type { AppDb } from "../../../db/client.ts";
import { webauthnChallenges } from "../../../db/schema.ts";

const CHALLENGE_TTL_SECONDS = 5 * 60;

export type ChallengePurpose = "register" | "authenticate" | "reauth";

/** Stores a server-generated WebAuthn challenge, returning its lookup id (never the challenge value itself, to the client). */
export async function storeChallenge(
  db: AppDb,
  challenge: string,
  purpose: ChallengePurpose,
  sessionId: string | null,
  now: () => number = Date.now,
): Promise<string> {
  const id = crypto.randomUUID();
  const nowIso = new Date(now()).toISOString();
  const expiresAtIso = new Date(now() + CHALLENGE_TTL_SECONDS * 1000).toISOString();
  await db
    .insert(webauthnChallenges)
    .values({ id, challenge, purpose, sessionId, createdAt: nowIso, expiresAt: expiresAtIso, consumed: 0 })
    .run();
  return id;
}

/**
 * Atomically consumes a pending challenge by its lookup id — single
 * UPDATE...RETURNING, same atomicity argument as reauth_nonces/
 * footage_segments. Returns the original challenge string only if it
 * existed, matched the expected purpose, hadn't expired, and hadn't
 * already been consumed.
 */
export async function consumeChallenge(
  db: AppDb,
  id: string,
  purpose: ChallengePurpose,
  now: () => number = Date.now,
): Promise<{ challenge: string; sessionId: string | null } | null> {
  const nowIso = new Date(now()).toISOString();
  // .returning() takes no field-selection argument here — that overload's
  // return type differs enough between the D1 and better-sqlite3 dialects
  // (AppDb is a union of both, so shared code can run against either in
  // tests vs. production) that TypeScript can't resolve a call to the
  // partial-fields overload across both at once. Selecting every column and
  // picking the two fields we need afterwards sidesteps that entirely.
  const rows = await db
    .update(webauthnChallenges)
    .set({ consumed: 1 })
    .where(
      sql`${webauthnChallenges.id} = ${id} AND ${webauthnChallenges.purpose} = ${purpose} AND ${webauthnChallenges.consumed} = 0 AND ${webauthnChallenges.expiresAt} > ${nowIso}`,
    )
    .returning()
    .all();
  const row = rows[0];
  return row ? { challenge: row.challenge, sessionId: row.sessionId } : null;
}
