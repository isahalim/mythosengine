import { eq } from "drizzle-orm";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
} from "@simplewebauthn/server";
import { getOne, type AppDb } from "../../../db/client.ts";
import { credentials } from "../../../db/schema.ts";
import { consumeChallenge, storeChallenge } from "./challenge-store.ts";

const RP_NAME = "Mythos Engine Console";
const OPERATOR_USER_ID = new TextEncoder().encode("operator");
const MAX_REGISTERED_CREDENTIALS = 2;

export interface RpConfig {
  rpID: string;
  origin: string;
}

async function allCredentials(db: AppDb) {
  return db.select().from(credentials).all();
}

// A plain count(*) projection hits the same cross-dialect .select(partial)
// overload friction documented in challenge-store.ts — selecting every row
// and counting them in JS avoids it. The credentials table never holds more
// than MAX_REGISTERED_CREDENTIALS rows, so this is never more than a
// two-row scan.
async function credentialCount(db: AppDb): Promise<number> {
  return (await allCredentials(db)).length;
}

export type BeginRegistrationResult =
  | { kind: "ok"; options: PublicKeyCredentialCreationOptionsJSON; challengeId: string }
  | { kind: "enrollment_closed" }
  | { kind: "invalid_token" };

/** CONSOLE_SPEC.md §1: one-time enrollment token, burns forever after the 2nd passkey registers. */
export async function beginRegistration(
  db: AppDb,
  rp: RpConfig,
  providedToken: string,
  expectedToken: string,
): Promise<BeginRegistrationResult> {
  if ((await credentialCount(db)) >= MAX_REGISTERED_CREDENTIALS) return { kind: "enrollment_closed" };
  // Trimmed on both sides: a secret set via `wrangler secret put` from a
  // piped file or `echo` without `-n` commonly carries a trailing newline
  // that a human pasting the same value into a browser field never types —
  // an exact-match comparison then fails forever, for a reason invisible
  // from either side. This can't regress into accepting a wrong token: a
  // real mismatch (different characters, not just edge whitespace) still
  // fails after trimming.
  if (providedToken.trim() !== expectedToken.trim()) return { kind: "invalid_token" };

  const existing = await allCredentials(db);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rp.rpID,
    userName: "operator",
    userID: OPERATOR_USER_ID,
    excludeCredentials: existing.map((c) => ({ id: c.credentialId })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  const challengeId = await storeChallenge(db, options.challenge, "register", null);
  return { kind: "ok", options, challengeId };
}

export type FinishRegistrationResult =
  | { kind: "ok"; credentialCount: number }
  | { kind: "invalid_challenge" }
  | { kind: "verification_failed" };

export async function finishRegistration(
  db: AppDb,
  rp: RpConfig,
  challengeId: string,
  response: RegistrationResponseJSON,
  label: string,
  now: () => number = Date.now,
): Promise<FinishRegistrationResult> {
  const pending = await consumeChallenge(db, challengeId, "register", now);
  if (pending === null) return { kind: "invalid_challenge" };

  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge: pending.challenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.rpID,
    requireUserVerification: true,
  });
  if (!verification.verified) return { kind: "verification_failed" };

  const { credential } = verification.registrationInfo;
  await db
    .insert(credentials)
    .values({
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports ? JSON.stringify(credential.transports) : null,
      createdAt: new Date(now()).toISOString(),
      label,
    })
    .run();

  return { kind: "ok", credentialCount: await credentialCount(db) };
}

export type BeginAuthResult = { options: PublicKeyCredentialRequestOptionsJSON; challengeId: string };

async function beginCeremony(db: AppDb, rp: RpConfig, purpose: "authenticate" | "reauth", sessionId: string | null): Promise<BeginAuthResult> {
  const existing = await allCredentials(db);
  const options = await generateAuthenticationOptions({
    rpID: rp.rpID,
    allowCredentials: existing.map((c) => ({
      id: c.credentialId,
      transports: c.transports ? JSON.parse(c.transports) : undefined,
    })),
    userVerification: "required",
  });
  const challengeId = await storeChallenge(db, options.challenge, purpose, sessionId);
  return { options, challengeId };
}

export function beginAuthentication(db: AppDb, rp: RpConfig): Promise<BeginAuthResult> {
  return beginCeremony(db, rp, "authenticate", null);
}

/** Step-up reauth ceremony (CONSOLE_SPEC.md §2) tied to the already-established session it will re-authorize. */
export function beginReauth(db: AppDb, rp: RpConfig, sessionId: string): Promise<BeginAuthResult> {
  return beginCeremony(db, rp, "reauth", sessionId);
}

export type FinishCeremonyResult =
  | { kind: "ok"; sessionId: string | null }
  | { kind: "invalid_challenge" }
  | { kind: "unknown_credential" }
  | { kind: "verification_failed" }
  | { kind: "counter_regression" };

async function finishCeremony(
  db: AppDb,
  rp: RpConfig,
  purpose: "authenticate" | "reauth",
  challengeId: string,
  response: AuthenticationResponseJSON,
  now: () => number,
): Promise<FinishCeremonyResult> {
  const pending = await consumeChallenge(db, challengeId, purpose, now);
  if (pending === null) return { kind: "invalid_challenge" };

  const stored = await getOne(db.select().from(credentials).where(eq(credentials.credentialId, response.id)));
  if (!stored) return { kind: "unknown_credential" };

  const credential: WebAuthnCredential = {
    id: stored.credentialId,
    publicKey: new Uint8Array(stored.publicKey),
    counter: stored.counter,
    transports: stored.transports ? JSON.parse(stored.transports) : undefined,
  };

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: pending.challenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.rpID,
    credential,
    requireUserVerification: true,
  });
  if (!verification.verified) return { kind: "verification_failed" };

  // Signature-counter-regression detection (CONSOLE_SPEC.md §1): a new
  // counter at or below the stored one (when the authenticator reports
  // counters at all — some return a constant 0) signals a possibly cloned
  // authenticator.
  const { newCounter } = verification.authenticationInfo;
  if (stored.counter !== 0 && newCounter !== 0 && newCounter <= stored.counter) {
    return { kind: "counter_regression" };
  }

  await db
    .update(credentials)
    .set({ counter: newCounter, lastUsedAt: new Date(now()).toISOString() })
    .where(eq(credentials.credentialId, stored.credentialId))
    .run();

  return { kind: "ok", sessionId: pending.sessionId };
}

export function finishAuthentication(
  db: AppDb,
  rp: RpConfig,
  challengeId: string,
  response: AuthenticationResponseJSON,
  now: () => number = Date.now,
): Promise<FinishCeremonyResult> {
  return finishCeremony(db, rp, "authenticate", challengeId, response, now);
}

export function finishReauth(
  db: AppDb,
  rp: RpConfig,
  challengeId: string,
  response: AuthenticationResponseJSON,
  now: () => number = Date.now,
): Promise<FinishCeremonyResult> {
  return finishCeremony(db, rp, "reauth", challengeId, response, now);
}
