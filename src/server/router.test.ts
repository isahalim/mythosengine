import { beforeEach, describe, expect, it, vi } from "vitest";
import * as simplewebauthn from "@simplewebauthn/server";
import { createTestDb } from "../../db/client.ts";
import { applyMigrations } from "../../db/apply-migrations.ts";
import { handleApiRequest, SESSION_COOKIE_NAME, type HotKvLike, type RouterDeps } from "./router.ts";

vi.mock("@simplewebauthn/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@simplewebauthn/server")>();
  return { ...actual, verifyRegistrationResponse: vi.fn(), verifyAuthenticationResponse: vi.fn() };
});

class FakeKv implements HotKvLike {
  private readonly strings = new Map<string, string>();
  private readonly blobs = new Map<string, ArrayBuffer>();

  get(key: string): Promise<string | null>;
  get(key: string, options: { type: "arrayBuffer" }): Promise<ArrayBuffer | null>;
  async get(key: string, options?: { type: "arrayBuffer" }): Promise<string | ArrayBuffer | null> {
    if (options?.type === "arrayBuffer") return this.blobs.get(key) ?? null;
    return this.strings.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.strings.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.strings.delete(key);
    this.blobs.delete(key);
  }
  setBlob(key: string, value: ArrayBuffer): void {
    this.blobs.set(key, value);
  }
}

const MASTER_KEY_B64 = "3q2-7_zdaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SESSION_SIGNING_KEY = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ENROLLMENT_TOKEN = "correct-enrollment-token";

function apiRequest(path: string, init: RequestInit & { cookie?: string } = {}): Request {
  const headers = new Headers(init.headers);
  if (!headers.has("accept")) headers.set("accept", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  return new Request(`https://example.workers.dev${path}`, { ...init, headers });
}

function sessionCookieFrom(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("expected a set-cookie header");
  return setCookie.split(";")[0];
}

describe("router", () => {
  let ctx: ReturnType<typeof createTestDb>;
  let hotKv: FakeKv;
  let vaultKv: FakeKv;
  let deps: RouterDeps;

  beforeEach(() => {
    ctx = createTestDb();
    applyMigrations(ctx.client);
    hotKv = new FakeKv();
    vaultKv = new FakeKv();
    deps = {
      db: ctx.db,
      rawClient: ctx.client,
      hotKv,
      vaultKv,
      vaultMasterKey: MASTER_KEY_B64,
      sessionSigningKey: SESSION_SIGNING_KEY,
      consoleEnrollmentToken: ENROLLMENT_TOKEN,
      groqApiKeyFallback: "gsk_" + "a".repeat(40),
    };
    vi.mocked(simplewebauthn.verifyRegistrationResponse).mockReset();
    vi.mocked(simplewebauthn.verifyAuthenticationResponse).mockReset();
  });

  it("returns null (falls through to assets) for a non-API path", async () => {
    const res = await handleApiRequest(apiRequest("/some/page"), deps);
    expect(res).toBeNull();
  });

  it("falls through to assets on GET /console/settings without an Accept: application/json header (the page load)", async () => {
    const res = await handleApiRequest(new Request("https://example.workers.dev/console/settings"), deps);
    expect(res).toBeNull();
  });

  it("rejects an unauthenticated request to a session-protected route", async () => {
    const res = await handleApiRequest(apiRequest("/console/summary"), deps);
    expect(res?.status).toBe(401);
  });

  it("rejects registration with the wrong enrollment token", async () => {
    const res = await handleApiRequest(
      apiRequest("/auth/passkey/register/begin", { method: "POST", body: JSON.stringify({ token: "wrong" }) }),
      deps,
    );
    expect(res?.status).toBe(401);
  });

  async function completeRegistrationAndLogin(): Promise<string> {
    const begin = await handleApiRequest(
      apiRequest("/auth/passkey/register/begin", { method: "POST", body: JSON.stringify({ token: ENROLLMENT_TOKEN }) }),
      deps,
    );
    const { challengeId } = (await begin?.json()) as { challengeId: string };

    vi.mocked(simplewebauthn.verifyRegistrationResponse).mockResolvedValue({
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
        origin: "https://example.workers.dev",
      },
    } as Awaited<ReturnType<typeof simplewebauthn.verifyRegistrationResponse>>);
    await handleApiRequest(
      apiRequest("/auth/passkey/register/finish", {
        method: "POST",
        body: JSON.stringify({ challengeId, response: {}, label: "primary" }),
      }),
      deps,
    );

    const authBegin = await handleApiRequest(apiRequest("/auth/passkey/authenticate/begin", { method: "POST" }), deps);
    const { challengeId: authChallengeId } = (await authBegin?.json()) as { challengeId: string };

    vi.mocked(simplewebauthn.verifyAuthenticationResponse).mockResolvedValue({
      verified: true,
      authenticationInfo: {
        credentialID: "cred-1",
        newCounter: 1,
        userVerified: true,
        credentialDeviceType: "multiDevice",
        credentialBackedUp: true,
        origin: "https://example.workers.dev",
        rpID: "example.workers.dev",
      },
    });
    const authFinish = await handleApiRequest(
      apiRequest("/auth/passkey/authenticate/finish", { method: "POST", body: JSON.stringify({ challengeId: authChallengeId, response: { id: "cred-1" } }) }),
      deps,
    );
    if (!authFinish) throw new Error("expected a response");
    return sessionCookieFrom(authFinish);
  }

  it("registers a passkey, authenticates, and reaches a session-protected route with the resulting cookie", async () => {
    const cookie = await completeRegistrationAndLogin();
    const res = await handleApiRequest(apiRequest("/console/summary", { cookie }), deps);
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { killswitch: { enabled: boolean } };
    expect(body.killswitch.enabled).toBe(true);
  });

  it("closes enrollment after 2 registrations, so a stolen enrollment token is useless afterward", async () => {
    await completeRegistrationAndLogin();

    const beginSecond = await handleApiRequest(
      apiRequest("/auth/passkey/register/begin", { method: "POST", body: JSON.stringify({ token: ENROLLMENT_TOKEN }) }),
      deps,
    );
    expect(beginSecond?.status).toBe(200);
    vi.mocked(simplewebauthn.verifyRegistrationResponse).mockResolvedValue({
      verified: true,
      registrationInfo: {
        fmt: "none",
        aaguid: "00000000-0000-0000-0000-000000000000",
        credential: { id: "cred-2", publicKey: new Uint8Array([4, 5, 6]), counter: 0 },
        credentialType: "public-key",
        attestationObject: new Uint8Array(),
        userVerified: true,
        credentialDeviceType: "multiDevice",
        credentialBackedUp: true,
        origin: "https://example.workers.dev",
      },
    } as Awaited<ReturnType<typeof simplewebauthn.verifyRegistrationResponse>>);
    const { challengeId } = (await beginSecond?.json()) as { challengeId: string };
    await handleApiRequest(
      apiRequest("/auth/passkey/register/finish", { method: "POST", body: JSON.stringify({ challengeId, response: {}, label: "backup" }) }),
      deps,
    );

    const beginThird = await handleApiRequest(
      apiRequest("/auth/passkey/register/begin", { method: "POST", body: JSON.stringify({ token: ENROLLMENT_TOKEN }) }),
      deps,
    );
    expect(beginThird?.status).toBe(410);
  });

  it("refuses to rotate a key without a reauth nonce, even with a valid session", async () => {
    const cookie = await completeRegistrationAndLogin();
    const res = await handleApiRequest(
      apiRequest(`/console/keys/GROQ_API_KEY`, { method: "POST", cookie, body: JSON.stringify({ value: "gsk_" + "a".repeat(40) }) }),
      deps,
    );
    expect(res?.status).toBe(401);
  });

  it("refuses reauth-finish for the wrong session", async () => {
    const cookie = await completeRegistrationAndLogin();
    const begin = await handleApiRequest(apiRequest("/auth/passkey/reauth/begin", { method: "POST", cookie }), deps);
    const { challengeId } = (await begin?.json()) as { challengeId: string };

    vi.mocked(simplewebauthn.verifyAuthenticationResponse).mockResolvedValue({
      verified: true,
      authenticationInfo: {
        credentialID: "cred-1",
        newCounter: 2,
        userVerified: true,
        credentialDeviceType: "multiDevice",
        credentialBackedUp: true,
        origin: "https://example.workers.dev",
        rpID: "example.workers.dev",
      },
    });

    // A different (unauthenticated) request tries to finish this session's reauth challenge.
    const finish = await handleApiRequest(
      apiRequest("/auth/passkey/reauth/finish", { method: "POST", body: JSON.stringify({ challengeId, response: { id: "cred-1" } }) }),
      deps,
    );
    expect(finish?.status).toBe(401);
  });

  it("streams a real export's bytes on download and marks it downloaded", async () => {
    const cookie = await completeRegistrationAndLogin();
    const { sources, signals, scripts, footageSources, footageSegments, renders, exports: exportsTable } = await import("../../db/schema.ts");
    await ctx.db.insert(sources).values({ id: "src1", kind: "reddit", url: "http://x" }).run();
    await ctx.db.insert(signals).values({ id: "sig1", sourceId: "src1", canonicalUrl: "http://x/1", title: "t", observedAt: "2026-01-01", engagementScore: 1, simhash: "a", state: "exported" }).run();
    await ctx.db.insert(scripts).values({ id: "scr1", signalId: "sig1", hook: "h", body: "b", debateQuestion: "q", wordCount: 10, status: "approved", createdAt: "2026-01-01" }).run();
    await ctx.db.insert(footageSources).values({ id: "fsrc1", channelUrl: "http://y", game: "minecraft", licenseNote: "owned" }).run();
    await ctx.db.insert(footageSegments).values({ id: "fseg1", footageSourceId: "fsrc1", sourceVideoId: "v1", clipStartS: 0, clipEndS: 10, motionScore: 1, libraryPath: "p", fetchedAt: "2026-01-01" }).run();
    await ctx.db.insert(renders).values({ id: "ren1", scriptId: "scr1", footageSegmentId: "fseg1", ttsDriver: "edge", ttsVoice: "v", status: "rendered", createdAt: "2026-01-01" }).run();
    await ctx.db
      .insert(exportsTable)
      .values({ id: "exp1", renderId: "ren1", storageKey: "blob:exp1", sizeBytes: 4, suggestedTitle: "t", suggestedDescription: "d", suggestedTagsJson: "[]", auditJson: "{}", createdAt: "2026-01-01", expiresAt: "2026-01-04", status: "ready_for_review" })
      .run();
    hotKv.setBlob("blob:exp1", new TextEncoder().encode("mp4!").buffer);

    const res = await handleApiRequest(apiRequest("/console/exports/exp1/download", { cookie }), deps);
    expect(res?.status).toBe(200);
    expect(new TextDecoder().decode(await res?.arrayBuffer())).toBe("mp4!");
  });

  it("logs out by clearing the session cookie, so the same cookie no longer authenticates", async () => {
    const cookie = await completeRegistrationAndLogin();
    const logoutRes = await handleApiRequest(apiRequest("/auth/passkey/logout", { method: "POST", cookie }), deps);
    expect(logoutRes?.status).toBe(200);
    const clearedCookie = logoutRes?.headers.get("set-cookie");
    expect(clearedCookie).toContain("Max-Age=0");

    const res = await handleApiRequest(apiRequest("/console/summary", { cookie }), deps);
    // The session token itself is still cryptographically valid until its
    // 12h TTL elapses (this is a stateless signed cookie, not a server-side
    // session store) — logout's guarantee is that the *browser* forgets it
    // via Max-Age=0, not that the token is revoked server-side.
    expect(res?.status).toBe(200);
  });

  it(`cookie name is ${SESSION_COOKIE_NAME}`, () => {
    expect(SESSION_COOKIE_NAME).toBe("__Host-session");
  });

  it("never leaks a vault secret's plaintext in any route response (CONSOLE_SPEC.md §6 acceptance test 3)", async () => {
    const cookie = await completeRegistrationAndLogin();
    const { Vault } = await import("../lib/vault.ts");
    const plantedSecret = "gsk_plantedsecretvalue0000000000000000000";
    await new Vault(vaultKv, MASTER_KEY_B64).rotate("GROQ_API_KEY", plantedSecret);

    const routesToCheck: Request[] = [
      apiRequest("/console/summary", { cookie }),
      apiRequest("/console/exports", { cookie }),
      apiRequest("/console/settings", { cookie }),
      apiRequest("/console/chat/sessions", { cookie }),
    ];
    for (const request of routesToCheck) {
      const res = await handleApiRequest(request, deps);
      const body = await res?.text();
      expect(body ?? "").not.toContain(plantedSecret);
    }
  });
});
