// __Host-session cookie (CONSOLE_SPEC.md §1): HttpOnly, Secure,
// SameSite=Strict, 12h TTL, HMAC-SHA256-signed over its payload with
// SESSION_SIGNING_KEY. No JWT library — this is three fields and one
// signature, and the Worker's native crypto.subtle already does everything
// a JWT library would add here, matching this project's general preference
// for reusing what the platform gives you (src/console/lib/api.ts reuses
// fetch/AbortSignal the same way) over a new dependency.

export const SESSION_COOKIE_NAME = "__Host-session";
const SESSION_TTL_SECONDS = 12 * 60 * 60;

export interface SessionPayload {
  sessionId: string;
  issuedAt: number; // epoch seconds
  expiresAt: number; // epoch seconds
}

function toBase64Url(bytes: Uint8Array<ArrayBuffer>): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importHmacKey(secretB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromBase64Url(secretB64), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

/** Issues a signed session token for a freshly-authenticated WebAuthn ceremony. */
export async function issueSessionToken(sessionId: string, signingKeyB64: string, now: () => number = Date.now): Promise<string> {
  const issuedAt = Math.floor(now() / 1000);
  const payload: SessionPayload = { sessionId, issuedAt, expiresAt: issuedAt + SESSION_TTL_SECONDS };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const key = await importHmacKey(signingKeyB64);
  const signature = await crypto.subtle.sign("HMAC", key, payloadBytes);
  return `${toBase64Url(payloadBytes)}.${toBase64Url(new Uint8Array(signature))}`;
}

/** Verifies a session token's signature and expiry. Never throws. */
export async function verifySessionToken(
  token: string,
  signingKeyB64: string,
  now: () => number = Date.now,
): Promise<SessionPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadPart, signaturePart] = parts;

  try {
    const key = await importHmacKey(signingKeyB64);
    const payloadBytes = fromBase64Url(payloadPart);
    const valid = await crypto.subtle.verify("HMAC", key, fromBase64Url(signaturePart), payloadBytes);
    if (!valid) return null;

    const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as SessionPayload;
    if (typeof payload.expiresAt !== "number" || payload.expiresAt * 1000 < now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function buildSessionCookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function buildSessionClearCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

function parseCookies(cookieHeader: string | null): Record<string, string> {
  if (!cookieHeader) return {};
  const out: Record<string, string> = {};
  for (const pair of cookieHeader.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return out;
}

/** Extracts and verifies the session from a request's Cookie header, or null. */
export async function getSession(request: Request, signingKeyB64: string): Promise<SessionPayload | null> {
  const cookies = parseCookies(request.headers.get("cookie"));
  const token = cookies[SESSION_COOKIE_NAME];
  if (!token) return null;
  return verifySessionToken(token, signingKeyB64);
}
