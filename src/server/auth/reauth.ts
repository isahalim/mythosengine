import { sql } from "drizzle-orm";
import type { AppDb } from "../../../db/client.ts";
import { reauthNonces } from "../../../db/schema.ts";

const REAUTH_TTL_SECONDS = 5 * 60;

function randomNonce(): string {
  return crypto.randomUUID();
}

/**
 * Step-up reauth (CONSOLE_SPEC.md §1/§2): key rotation and the killswitch
 * require a fresh WebAuthn assertion completed within the last 5 minutes.
 * Issued once a passkey re-authentication ceremony succeeds
 * (src/server/auth/webauthn.ts's finishReauth); consumed exactly once by
 * the sensitive route it gates.
 */
export async function issueReauthNonce(db: AppDb, sessionId: string, now: () => number = Date.now): Promise<string> {
  const nonce = randomNonce();
  const nowIso = new Date(now()).toISOString();
  const expiresAtIso = new Date(now() + REAUTH_TTL_SECONDS * 1000).toISOString();
  await db.insert(reauthNonces).values({ nonce, sessionId, createdAt: nowIso, expiresAt: expiresAtIso, consumed: 0 }).run();
  return nonce;
}

/**
 * Atomically consumes a reauth nonce — single UPDATE...RETURNING, same
 * atomicity argument as db/footage-select.ts's claimNextFootageSegment: no
 * read-then-write window for a second caller (or a replay) to race into.
 * Returns true only if the nonce existed, belonged to this session, wasn't
 * already consumed, and hasn't expired.
 */
export async function consumeReauthNonce(
  db: AppDb,
  nonce: string,
  sessionId: string,
  now: () => number = Date.now,
): Promise<boolean> {
  const nowIso = new Date(now()).toISOString();
  // See the identical comment in challenge-store.ts's consumeChallenge:
  // .returning() (no field selection) is the overload that resolves
  // consistently across AppDb's D1/better-sqlite3 union.
  const result = await db
    .update(reauthNonces)
    .set({ consumed: 1 })
    .where(
      sql`${reauthNonces.nonce} = ${nonce} AND ${reauthNonces.sessionId} = ${sessionId} AND ${reauthNonces.consumed} = 0 AND ${reauthNonces.expiresAt} > ${nowIso}`,
    )
    .returning()
    .all();
  return result.length === 1;
}
