import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RegistrationResponseJSON, AuthenticationResponseJSON } from "@simplewebauthn/server";
import { createTestDb } from "../../../db/client.ts";
import { applyMigrations } from "../../../db/apply-migrations.ts";

// This suite tests the orchestration this module owns — challenge
// lifecycle, the enrollment-token/close-after-2 rule, counter-regression
// detection, and credential persistence — not whether @simplewebauthn/
// server correctly implements the WebAuthn spec itself (that's the
// library's own, separately-tested responsibility). verifyRegistrationResponse
// / verifyAuthenticationResponse are mocked to return canned verified/
// unverified results so each branch of this file's own logic is reachable
// without hand-rolling real authenticator cryptography in a test.
vi.mock("@simplewebauthn/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@simplewebauthn/server")>();
  return {
    ...actual,
    verifyRegistrationResponse: vi.fn(),
    verifyAuthenticationResponse: vi.fn(),
  };
});

const { verifyRegistrationResponse, verifyAuthenticationResponse } = await import("@simplewebauthn/server");

const rp = { rpID: "example.workers.dev", origin: "https://example.workers.dev" };
const FAKE_REGISTRATION_RESPONSE = {} as RegistrationResponseJSON;
const FAKE_AUTH_RESPONSE = { id: "cred-1" } as AuthenticationResponseJSON;

describe("webauthn ceremonies", () => {
  let ctx: ReturnType<typeof createTestDb>;

  beforeEach(async () => {
    ctx = createTestDb();
    applyMigrations(ctx.client);
    vi.mocked(verifyRegistrationResponse).mockReset();
    vi.mocked(verifyAuthenticationResponse).mockReset();
  });

  it("rejects registration with the wrong enrollment token", async () => {
    const { beginRegistration } = await import("./webauthn.ts");
    const result = await beginRegistration(ctx.db, rp, "wrong-token", "correct-token");
    expect(result.kind).toBe("invalid_token");
  });

  it("issues registration options for a correct token", async () => {
    const { beginRegistration } = await import("./webauthn.ts");
    const result = await beginRegistration(ctx.db, rp, "correct-token", "correct-token");
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.options.rp.id).toBe(rp.rpID);
      expect(result.challengeId).toBeTruthy();
    }
  });

  it("completes registration and stores a credential on a verified response", async () => {
    const { beginRegistration, finishRegistration } = await import("./webauthn.ts");
    const begun = await beginRegistration(ctx.db, rp, "correct-token", "correct-token");
    if (begun.kind !== "ok") throw new Error("expected ok");

    vi.mocked(verifyRegistrationResponse).mockResolvedValue({
      verified: true,
      registrationInfo: {
        fmt: "none",
        aaguid: "00000000-0000-0000-0000-000000000000",
        credential: { id: "cred-1", publicKey: new Uint8Array([1, 2, 3]), counter: 0 },
        credentialType: "public-key",
        attestationObject: new Uint8Array(),
        userVerified: true,
        credentialDeviceType: "multiDevice",
        credentialBackedUp: true,
        origin: rp.origin,
      },
      // deno-lint-ignore no-explicit-any
    } as Awaited<ReturnType<typeof verifyRegistrationResponse>>);

    const finished = await finishRegistration(ctx.db, rp, begun.challengeId, FAKE_REGISTRATION_RESPONSE, "primary key");
    expect(finished).toEqual({ kind: "ok", credentialCount: 1 });
  });

  it("refuses a second finishRegistration call reusing the same (already-consumed) challenge", async () => {
    const { beginRegistration, finishRegistration } = await import("./webauthn.ts");
    const begun = await beginRegistration(ctx.db, rp, "correct-token", "correct-token");
    if (begun.kind !== "ok") throw new Error("expected ok");

    vi.mocked(verifyRegistrationResponse).mockResolvedValue({
      verified: true,
      registrationInfo: {
        fmt: "none",
        aaguid: "00000000-0000-0000-0000-000000000000",
        credential: { id: "cred-1", publicKey: new Uint8Array([1, 2, 3]), counter: 0 },
        credentialType: "public-key",
        attestationObject: new Uint8Array(),
        userVerified: true,
        credentialDeviceType: "multiDevice",
        credentialBackedUp: true,
        origin: rp.origin,
      },
    } as Awaited<ReturnType<typeof verifyRegistrationResponse>>);

    await finishRegistration(ctx.db, rp, begun.challengeId, FAKE_REGISTRATION_RESPONSE, "primary key");
    const second = await finishRegistration(ctx.db, rp, begun.challengeId, FAKE_REGISTRATION_RESPONSE, "primary key");
    expect(second.kind).toBe("invalid_challenge");
  });

  it("closes enrollment for good once two credentials are registered, regardless of the token", async () => {
    const { beginRegistration, finishRegistration } = await import("./webauthn.ts");

    for (let i = 0; i < 2; i++) {
      const begun = await beginRegistration(ctx.db, rp, "correct-token", "correct-token");
      if (begun.kind !== "ok") throw new Error("expected ok");
      vi.mocked(verifyRegistrationResponse).mockResolvedValue({
        verified: true,
        registrationInfo: {
          fmt: "none",
          aaguid: "00000000-0000-0000-0000-000000000000",
          credential: { id: `cred-${i}`, publicKey: new Uint8Array([1, 2, 3]), counter: 0 },
          credentialType: "public-key",
          attestationObject: new Uint8Array(),
          userVerified: true,
          credentialDeviceType: "multiDevice",
          credentialBackedUp: true,
          origin: rp.origin,
        },
      } as Awaited<ReturnType<typeof verifyRegistrationResponse>>);
      await finishRegistration(ctx.db, rp, begun.challengeId, FAKE_REGISTRATION_RESPONSE, `key ${i}`);
    }

    const thirdAttempt = await beginRegistration(ctx.db, rp, "correct-token", "correct-token");
    expect(thirdAttempt.kind).toBe("enrollment_closed");
  });

  it("rejects authentication against an unknown credential id", async () => {
    const { beginAuthentication, finishAuthentication } = await import("./webauthn.ts");
    const begun = await beginAuthentication(ctx.db, rp);
    const finished = await finishAuthentication(ctx.db, rp, begun.challengeId, FAKE_AUTH_RESPONSE);
    expect(finished.kind).toBe("unknown_credential");
  });

  it("detects a signature counter regression and refuses to authenticate", async () => {
    const { db } = ctx;
    const { credentials } = await import("../../../db/schema.ts");
    await db
      .insert(credentials)
      .values({
        credentialId: "cred-1",
        publicKey: Buffer.from([1, 2, 3]),
        counter: 10,
        createdAt: new Date().toISOString(),
        label: "primary key",
      })
      .run();

    const { beginAuthentication, finishAuthentication } = await import("./webauthn.ts");
    const begun = await beginAuthentication(ctx.db, rp);

    vi.mocked(verifyAuthenticationResponse).mockResolvedValue({
      verified: true,
      authenticationInfo: {
        credentialID: "cred-1",
        newCounter: 5, // lower than the stored counter (10) — a clone signal
        userVerified: true,
        credentialDeviceType: "multiDevice",
        credentialBackedUp: true,
        origin: rp.origin,
        rpID: rp.rpID,
      },
    });

    const finished = await finishAuthentication(ctx.db, rp, begun.challengeId, FAKE_AUTH_RESPONSE);
    expect(finished.kind).toBe("counter_regression");
  });

  it("authenticates successfully and advances the stored counter", async () => {
    const { db } = ctx;
    const { credentials } = await import("../../../db/schema.ts");
    await db
      .insert(credentials)
      .values({
        credentialId: "cred-1",
        publicKey: Buffer.from([1, 2, 3]),
        counter: 10,
        createdAt: new Date().toISOString(),
        label: "primary key",
      })
      .run();

    const { beginAuthentication, finishAuthentication } = await import("./webauthn.ts");
    const begun = await beginAuthentication(ctx.db, rp);

    vi.mocked(verifyAuthenticationResponse).mockResolvedValue({
      verified: true,
      authenticationInfo: {
        credentialID: "cred-1",
        newCounter: 11,
        userVerified: true,
        credentialDeviceType: "multiDevice",
        credentialBackedUp: true,
        origin: rp.origin,
        rpID: rp.rpID,
      },
    });

    const finished = await finishAuthentication(ctx.db, rp, begun.challengeId, FAKE_AUTH_RESPONSE);
    expect(finished.kind).toBe("ok");

    const { eq } = await import("drizzle-orm");
    const row = await db.select().from(credentials).where(eq(credentials.credentialId, "cred-1")).get();
    expect(row?.counter).toBe(11);
  });

  it("ties a reauth ceremony to the session that requested it", async () => {
    const { db } = ctx;
    const { credentials } = await import("../../../db/schema.ts");
    await db
      .insert(credentials)
      .values({
        credentialId: "cred-1",
        publicKey: Buffer.from([1, 2, 3]),
        counter: 0,
        createdAt: new Date().toISOString(),
        label: "primary key",
      })
      .run();

    const { beginReauth, finishReauth } = await import("./webauthn.ts");
    const begun = await beginReauth(ctx.db, rp, "session-42");

    vi.mocked(verifyAuthenticationResponse).mockResolvedValue({
      verified: true,
      authenticationInfo: {
        credentialID: "cred-1",
        newCounter: 1,
        userVerified: true,
        credentialDeviceType: "multiDevice",
        credentialBackedUp: true,
        origin: rp.origin,
        rpID: rp.rpID,
      },
    });

    const finished = await finishReauth(ctx.db, rp, begun.challengeId, FAKE_AUTH_RESPONSE);
    expect(finished).toEqual({ kind: "ok", sessionId: "session-42" });
  });
});
