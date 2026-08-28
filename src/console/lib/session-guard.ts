// A 401 from any /console/* call means "you're not signed in, or your
// session expired" — a completely different, actionable situation from a
// real network/server failure, and every console page used to show the
// exact same vague "Console API not reachable" banner for both (the
// operator's own complaint: an unexplained error that "doesn't work").
// Call this first in every failed-result branch; it redirects straight to
// the login page instead of leaving the page sitting there looking broken.
import type { DriverError } from "../../lib/drivers/types.ts";

const LOGIN_PATH = "/console/login";

function isUnauthorized(error: DriverError): boolean {
  return error.message.startsWith("HTTP 401");
}

/** Returns true if it redirected — callers should stop (not also render the generic error banner) when this returns true. */
export function redirectIfUnauthorized(error: DriverError): boolean {
  if (!isUnauthorized(error)) return false;
  const next = encodeURIComponent(window.location.pathname);
  window.location.href = `${LOGIN_PATH}?next=${next}`;
  return true;
}
