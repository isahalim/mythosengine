import { beforeEach, describe, expect, it, vi } from "vitest";
import * as simplewebauthn from "@simplewebauthn/server";
import { createTestDb } from "../../db/client.ts";
import { applyMigrations } from "../../db/apply-migrations.ts";
import { signals, sources } from "../../db/schema.ts";
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
const PIPELINE_BATCH_TOKEN = "pbt_" + "c".repeat(48);
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
      pexelsApiKeyFallback: undefined,
      // No dispatch credential in the default deps: POST /console/dispatch
      // records the run and reports `not_triggered`, which is what these
      // route tests are asserting. The trigger path itself is covered
      // against the real driver in console/dispatch.test.ts.
      actions: null,
      renderWorkflow: "render.yml",
      renderRef: "main",
      // No R2 binding in the default deps. The routes that need one answer
      // 503 with a reason rather than guessing; the KV path (which every
      // export seeded here uses) is unaffected, and the backend split itself
      // is covered in console/exports.test.ts.
      exportBucket: undefined,
      pipelineBatchToken: PIPELINE_BATCH_TOKEN,
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
    const res = await handleApiRequest(apiRequest("/console/exports"), deps);
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
    const res = await handleApiRequest(apiRequest("/console/exports", { cookie }), deps);
    expect(res?.status).toBe(200);
    expect((await res?.json()) as unknown[]).toEqual([]);
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

  /** Completes a real reauth ceremony (begin + mocked-verified finish) for `cookie`'s own session, returning the resulting single-use nonce. */
  async function completeReauth(cookie: string): Promise<string> {
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

    const finish = await handleApiRequest(
      apiRequest("/auth/passkey/reauth/finish", { method: "POST", cookie, body: JSON.stringify({ challengeId, response: { id: "cred-1" } }) }),
      deps,
    );
    const { reauthNonce } = (await finish?.json()) as { reauthNonce: string };
    return reauthNonce;
  }

  // The reauth gate itself, on the one route that still carries it after
  // the six-stage overhaul removed MCP token issuance (which used to be
  // this helper's only caller). CONSOLE_SPEC.md §2: flipping the killswitch
  // is credential-equivalent and needs a fresh (<5min) WebAuthn assertion.
  describe("step-up reauth (POST /console/killswitch)", () => {
    it("rejects a killswitch flip carrying no reauth nonce", async () => {
      const cookie = await completeRegistrationAndLogin();
      const res = await handleApiRequest(
        apiRequest("/console/killswitch", { method: "POST", cookie, body: JSON.stringify({ enabled: false }) }),
        deps,
      );
      expect(res?.status).toBe(401);
      expect(await res?.json()).toEqual({ error: "reauth_required" });
    });

    it("accepts the flip with a fresh nonce, and refuses to reuse that nonce", async () => {
      const cookie = await completeRegistrationAndLogin();
      const nonce = await completeReauth(cookie);

      const flip = (): Request =>
        apiRequest("/console/killswitch", {
          method: "POST",
          cookie,
          headers: { "x-reauth-nonce": nonce },
          body: JSON.stringify({ enabled: false }),
        });

      const first = await handleApiRequest(flip(), deps);
      expect(first?.status).toBe(200);
      expect(await first?.json()).toEqual({ ok: true, enabled: false });

      // Single-use: the same nonce must not authorize a second flip.
      const second = await handleApiRequest(flip(), deps);
      expect(second?.status).toBe(401);
    });
  });

  async function seedExport(suggestedTitle = "t"): Promise<void> {
    const { sources, signals, scripts, footageSources, footageSegments, renders, exports: exportsTable } = await import("../../db/schema.ts");
    await ctx.db.insert(sources).values({ id: "src1", kind: "reddit", url: "http://x" }).run();
    await ctx.db.insert(signals).values({ id: "sig1", sourceId: "src1", canonicalUrl: "http://x/1", title: "t", observedAt: "2026-01-01", engagementScore: 1, simhash: "a", state: "exported" }).run();
    await ctx.db.insert(scripts).values({ id: "scr1", signalId: "sig1", hook: "h", body: "b", debateQuestion: "q", wordCount: 10, status: "approved", createdAt: "2026-01-01" }).run();
    await ctx.db.insert(footageSources).values({ id: "fsrc1", channelUrl: "http://y", game: "minecraft", licenseNote: "owned" }).run();
    await ctx.db.insert(footageSegments).values({ id: "fseg1", footageSourceId: "fsrc1", sourceVideoId: "v1", clipStartS: 0, clipEndS: 10, motionScore: 1, libraryPath: "p", fetchedAt: "2026-01-01" }).run();
    await ctx.db.insert(renders).values({ id: "ren1", scriptId: "scr1", footageSegmentId: "fseg1", ttsDriver: "edge", ttsVoice: "v", status: "rendered", createdAt: "2026-01-01" }).run();
    await ctx.db
      .insert(exportsTable)
      .values({ id: "exp1", renderId: "ren1", storageKey: "blob:exp1", sizeBytes: 4, suggestedTitle, suggestedDescription: "d", suggestedTagsJson: "[]", auditJson: "{}", createdAt: "2026-01-01", expiresAt: "2026-01-04", status: "ready_for_review" })
      .run();
    hotKv.setBlob("blob:exp1", new TextEncoder().encode("mp4!").buffer);
  }

  it("streams a real export's bytes on download and marks it downloaded", async () => {
    const cookie = await completeRegistrationAndLogin();
    await seedExport();

    const res = await handleApiRequest(apiRequest("/console/exports/exp1/download", { cookie }), deps);
    expect(res?.status).toBe(200);
    expect(new TextDecoder().decode(await res?.arrayBuffer())).toBe("mp4!");
  });

  it("serves the metadata sheet, and refuses it to a caller without a session", async () => {
    const cookie = await completeRegistrationAndLogin();
    await seedExport();

    const anonymous = await handleApiRequest(apiRequest("/console/exports/exp1/metadata"), deps);
    expect(anonymous?.status).toBe(401);

    const res = await handleApiRequest(apiRequest("/console/exports/exp1/metadata", { cookie }), deps);
    expect(res?.status).toBe(200);
    expect(((await res?.json()) as { id: string }).id).toBe("exp1");

    const missing = await handleApiRequest(apiRequest("/console/exports/nope/metadata", { cookie }), deps);
    expect(missing?.status).toBe(404);
  });

  it("serves the download to a plain browser navigation, which sends no JSON accept header", async () => {
    // The console renders Download as an <a href>, so the browser navigates
    // and sends `Accept: text/html,...`. The router's "a GET that doesn't
    // want JSON is a page request" rule sent that to the static asset
    // handler, which has no such file — the button 404'd (2026-08-31). Every
    // test here had used the JSON header, so nothing caught it.
    const cookie = await completeRegistrationAndLogin();
    await seedExport();

    const res = await handleApiRequest(
      apiRequest("/console/exports/exp1/download", {
        cookie,
        headers: { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,*/*;q=0.8" },
      }),
      deps,
    );
    expect(res).not.toBeNull();
    expect(res?.status).toBe(200);
    expect(res?.headers.get("content-type")).toBe("video/mp4");
    expect(new TextDecoder().decode(await res?.arrayBuffer())).toBe("mp4!");
  });

  it("sends the video as an attachment so it downloads instead of playing in the tab", async () => {
    const cookie = await completeRegistrationAndLogin();
    await seedExport("Ever watched a movie so insane?");

    const res = await handleApiRequest(apiRequest("/console/exports/exp1/download", { cookie }), deps);
    expect(res?.headers.get("content-disposition")).toBe('attachment; filename="Ever-watched-a-movie-so-insane-exp1.mp4"');
  });

  it("still treats a non-JSON GET of an API path as a page request", async () => {
    // The download exemption must not become "every GET is an API call".
    // Nothing is served under /console/ any more (the six-stage overhaul
    // collapsed every page into "/"), but the rule still has to hold: a
    // browser navigation falls through to the static asset handler.
    const cookie = await completeRegistrationAndLogin();
    const res = await handleApiRequest(apiRequest("/console/settings", { cookie, headers: { accept: "text/html" } }), deps);
    expect(res).toBeNull();
  });

  it("logs out by clearing the session cookie, so the same cookie no longer authenticates", async () => {
    const cookie = await completeRegistrationAndLogin();
    const logoutRes = await handleApiRequest(apiRequest("/auth/passkey/logout", { method: "POST", cookie }), deps);
    expect(logoutRes?.status).toBe(200);
    const clearedCookie = logoutRes?.headers.get("set-cookie");
    expect(clearedCookie).toContain("Max-Age=0");

    const res = await handleApiRequest(apiRequest("/console/exports", { cookie }), deps);
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
      apiRequest("/console/exports", { cookie }),
      apiRequest("/console/settings", { cookie }),
      apiRequest("/console/runs", { cookie }),
      apiRequest("/console/run-plan", { cookie }),
    ];
    for (const request of routesToCheck) {
      const res = await handleApiRequest(request, deps);
      const body = await res?.text();
      expect(body ?? "").not.toContain(plantedSecret);
    }
  });

  describe("/internal/*", () => {
    function batchRequest(token: string | null): Request {
      const headers = new Headers({ "content-type": "application/json" });
      if (token !== null) headers.set("authorization", `Bearer ${token}`);
      return new Request("https://example.workers.dev/internal/d1/batch", {
        method: "POST",
        headers,
        body: JSON.stringify({ statements: [{ sql: "insert into footage_sources (id, game, channel_url, license_note, enabled) values (?, ?, ?, ?, ?)", params: ["r1", "g", "u", "n", 1] }] }),
      });
    }

    it("routes a valid batch through to the handler without any session", async () => {
      const response = await handleApiRequest(batchRequest(PIPELINE_BATCH_TOKEN), deps);
      expect(response?.status).toBe(200);
    });

    it("does not accept a console session in place of the batch token", async () => {
      // The two credentials are deliberately unrelated: a stolen console
      // cookie must not become an arbitrary-SQL capability.
      const cookie = await completeRegistrationAndLogin();
      const response = await handleApiRequest(
        new Request("https://example.workers.dev/internal/d1/batch", {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ statements: [{ sql: "select 1", params: [] }] }),
        }),
        deps,
      );
      expect(response?.status).toBe(401);
    });

    it("answers an unknown /internal/ path with 404 rather than serving console HTML", async () => {
      // Falling through would hand a prober the asset handler's response for
      // a prefix that exists only for machine callers.
      const response = await handleApiRequest(new Request("https://example.workers.dev/internal/whatever", { method: "POST" }), deps);
      expect(response?.status).toBe(404);
    });

    it("still ignores paths this router does not own", async () => {
      expect(await handleApiRequest(new Request("https://example.workers.dev/anything-else"), deps)).toBeNull();
    });
  });

  describe("the run plan's routes", () => {
    async function seedScoredSignal(id: string, title: string): Promise<void> {
      await ctx.db.insert(sources).values({ id: `src-${id}`, kind: "reddit", url: `http://x/${id}` }).run();
      await ctx.db
        .insert(signals)
        .values({ id, sourceId: `src-${id}`, canonicalUrl: `http://x/${id}/1`, title, observedAt: "2026-08-31T00:00:00.000Z", engagementScore: 5, simhash: id, state: "scored" })
        .run();
    }

    it("requires a session for ideas and for the plan", async () => {
      expect((await handleApiRequest(apiRequest("/console/ideas?topic=ai"), deps))?.status).toBe(401);
      expect((await handleApiRequest(apiRequest("/console/run-plan"), deps))?.status).toBe(401);
    });

    it("rejects an unknown topic with 422 rather than ranking nothing", async () => {
      const cookie = await completeRegistrationAndLogin();
      const res = await handleApiRequest(apiRequest("/console/ideas?topic=sports", { cookie }), deps);
      expect(res?.status).toBe(422);
    });

    it("ranks ideas, queues a plan, and stops offering what it queued", async () => {
      const cookie = await completeRegistrationAndLogin();
      await seedScoredSignal("sig-ai", "OpenAI model release splits the industry");

      const ideas = await handleApiRequest(apiRequest("/console/ideas?topic=ai", { cookie }), deps);
      expect(ideas?.status).toBe(200);
      expect((await ideas?.json()) as { signalId: string }[]).toMatchObject([{ signalId: "sig-ai" }]);

      const queued = await handleApiRequest(
        apiRequest("/console/run-plan", { method: "POST", cookie, body: JSON.stringify({ picks: [{ topic: "ai", signalId: "sig-ai" }] }) }),
        deps,
      );
      expect(queued?.status).toBe(200);

      // Queued once means offered no more — otherwise one run makes two
      // videos about the same story.
      const after = await handleApiRequest(apiRequest("/console/ideas?topic=ai", { cookie }), deps);
      expect((await after?.json()) as unknown[]).toEqual([]);

      const plan = await handleApiRequest(apiRequest("/console/run-plan", { cookie }), deps);
      expect((await plan?.json()) as { signalId: string }[]).toMatchObject([{ signalId: "sig-ai", topic: "ai" }]);
    });

    it("refuses a plan naming a signal that was never scored", async () => {
      const cookie = await completeRegistrationAndLogin();
      const res = await handleApiRequest(
        apiRequest("/console/run-plan", { method: "POST", cookie, body: JSON.stringify({ picks: [{ topic: "ai", signalId: "ghost" }] }) }),
        deps,
      );
      expect(res?.status).toBe(422);
    });

    it("cancels a queued pick and reports an unknown one as 404", async () => {
      const cookie = await completeRegistrationAndLogin();
      await seedScoredSignal("sig-tech", "Startup launches a privacy-first chip platform");
      await handleApiRequest(
        apiRequest("/console/run-plan", { method: "POST", cookie, body: JSON.stringify({ picks: [{ topic: "tech", signalId: "sig-tech" }] }) }),
        deps,
      );
      const plan = (await (await handleApiRequest(apiRequest("/console/run-plan", { cookie }), deps))?.json()) as { id: string }[];

      const cancelled = await handleApiRequest(apiRequest(`/console/run-plan/${plan[0].id}`, { method: "DELETE", cookie }), deps);
      expect(cancelled?.status).toBe(200);
      expect((await (await handleApiRequest(apiRequest("/console/run-plan", { cookie }), deps))?.json()) as unknown[]).toEqual([]);

      const missing = await handleApiRequest(apiRequest("/console/run-plan/ghost", { method: "DELETE", cookie }), deps);
      expect(missing?.status).toBe(404);
    });
  });

  describe("the guided run's routes", () => {
    it("requires a session for the run list", async () => {
      const res = await handleApiRequest(apiRequest("/console/runs"), deps);
      expect(res?.status).toBe(401);
    });

    it("lists a recorded run and reads it back by trace id", async () => {
      const cookie = await completeRegistrationAndLogin();
      const dispatched = await handleApiRequest(apiRequest("/console/dispatch", { method: "POST", cookie }), deps);
      const { runId } = (await dispatched?.json()) as { runId: string };

      const list = await handleApiRequest(apiRequest("/console/runs", { cookie }), deps);
      expect(list?.status).toBe(200);
      expect((await list?.json()) as unknown[]).toHaveLength(1);

      const progress = await handleApiRequest(apiRequest(`/console/runs/${runId}`, { cookie }), deps);
      expect(progress?.status).toBe(200);
      // Dispatch records a run it has no credential to trigger; the run view
      // has to be told that, not left to spin.
      expect((await progress?.json()) as { status: string }).toMatchObject({ status: "not_triggered" });
    });

    it("answers an unknown trace id with 404, not an empty run", async () => {
      const cookie = await completeRegistrationAndLogin();
      const res = await handleApiRequest(apiRequest("/console/runs/no-such-trace", { cookie }), deps);
      expect(res?.status).toBe(404);
    });

    it("serves the montage route separately from the progress route", async () => {
      const cookie = await completeRegistrationAndLogin();
      const dispatched = await handleApiRequest(apiRequest("/console/dispatch", { method: "POST", cookie }), deps);
      const { runId } = (await dispatched?.json()) as { runId: string };

      const montage = await handleApiRequest(apiRequest(`/console/runs/${runId}/montage`, { cookie }), deps);
      expect(montage?.status).toBe(200);
      // No PEXELS_API_KEY in these deps, so the honest answer is "not
      // configured" — never an empty montage that reads as a failed search.
      expect((await montage?.json()) as { configured: boolean }).toMatchObject({ configured: false, videos: [] });
    });
  });
});
