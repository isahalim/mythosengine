/**
 * The bearer check both `/internal/*` routes sit behind.
 *
 * Extracted from d1-batch.ts when `/internal/exports/:key` arrived, rather
 * than copied: a second, subtly different constant-time compare is exactly
 * the kind of duplication that rots into a real one.
 */

/**
 * Compares two secrets without leaking their contents through timing.
 *
 * Both sides are hashed first, so the comparison always runs over 32 fixed
 * bytes: a plain length check on the raw strings would leak the token's
 * length, and an early-exit `===` would leak a prefix. `crypto.subtle` is
 * available in workerd, so this needs no dependency.
 */
export async function secretsMatch(presented: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(presented)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

/**
 * `null` when the request may proceed; a Response when it may not.
 *
 * Fail-closed when the secret is unset: an unconfigured deployment refuses
 * rather than opening an unauthenticated write endpoint. The caller logs
 * which variable is missing — never its value (CLAUDE.md).
 */
export async function checkSharedSecret(request: Request, expected: string | undefined): Promise<Response | null> {
  if (expected === undefined || expected.length === 0) {
    return Response.json({ error: "not_configured" }, { status: 503 });
  }
  const authorization = request.headers.get("authorization");
  if (authorization === null || !authorization.startsWith("Bearer ")) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!(await secretsMatch(authorization.slice("Bearer ".length), expected))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}
