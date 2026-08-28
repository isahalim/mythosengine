import { describe, expect, it } from "vitest";
import { buildSessionCookie, getSession, issueSessionToken, SESSION_COOKIE_NAME, verifySessionToken } from "./session.ts";

const SIGNING_KEY_B64 = "3q2-7_zdaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("session token", () => {
  it("round-trips a freshly-issued token", async () => {
    const token = await issueSessionToken("session-1", SIGNING_KEY_B64);
    const payload = await verifySessionToken(token, SIGNING_KEY_B64);
    expect(payload?.sessionId).toBe("session-1");
  });

  it("rejects a token signed with a different key", async () => {
    const token = await issueSessionToken("session-1", SIGNING_KEY_B64);
    const otherKey = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const payload = await verifySessionToken(token, otherKey);
    expect(payload).toBeNull();
  });

  it("rejects a tampered payload even if the signature part is untouched", async () => {
    const token = await issueSessionToken("session-1", SIGNING_KEY_B64);
    const [, signature] = token.split(".");
    const forged = `${btoa(JSON.stringify({ sessionId: "someone-else", issuedAt: 0, expiresAt: 9999999999 })).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}.${signature}`;
    const payload = await verifySessionToken(forged, SIGNING_KEY_B64);
    expect(payload).toBeNull();
  });

  it("rejects an expired token", async () => {
    let now = 0;
    const token = await issueSessionToken("session-1", SIGNING_KEY_B64, () => now);
    now = (13 * 60 * 60 + 1) * 1000; // past the 12h TTL
    const payload = await verifySessionToken(token, SIGNING_KEY_B64, () => now);
    expect(payload).toBeNull();
  });

  it("rejects a malformed token instead of throwing", async () => {
    const payload = await verifySessionToken("not-a-valid-token", SIGNING_KEY_B64);
    expect(payload).toBeNull();
  });

  it("extracts a valid session from a request's Cookie header", async () => {
    const token = await issueSessionToken("session-1", SIGNING_KEY_B64);
    const request = new Request("https://example.com/console/summary", {
      headers: { cookie: `other=1; ${SESSION_COOKIE_NAME}=${token}` },
    });
    const session = await getSession(request, SIGNING_KEY_B64);
    expect(session?.sessionId).toBe("session-1");
  });

  it("returns null when no session cookie is present", async () => {
    const request = new Request("https://example.com/console/summary");
    const session = await getSession(request, SIGNING_KEY_B64);
    expect(session).toBeNull();
  });

  it("builds a cookie string with the required security attributes", () => {
    const cookie = buildSessionCookie("token-value");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie.startsWith(`${SESSION_COOKIE_NAME}=token-value`)).toBe(true);
  });
});
