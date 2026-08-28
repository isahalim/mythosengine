import { afterEach, describe, expect, it, vi } from "vitest";
import { redirectIfUnauthorized } from "./session-guard.ts";
import type { DriverError } from "../../lib/drivers/types.ts";

function driverError(message: string): DriverError {
  return { kind: "provider_error", message, retryable: false };
}

describe("redirectIfUnauthorized", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("redirects to the login page with ?next= on a 401, and reports that it redirected", () => {
    const location = { pathname: "/console/settings", href: "" };
    vi.stubGlobal("window", { location });

    const redirected = redirectIfUnauthorized(driverError("HTTP 401 from /console/settings"));

    expect(redirected).toBe(true);
    expect(location.href).toBe("/console/login?next=%2Fconsole%2Fsettings");
  });

  it("does nothing for a non-401 error — a real fault stays a real fault", () => {
    const location = { pathname: "/console/settings", href: "" };
    vi.stubGlobal("window", { location });

    const redirected = redirectIfUnauthorized(driverError("HTTP 500 from /console/settings"));

    expect(redirected).toBe(false);
    expect(location.href).toBe("");
  });

  it("does nothing for a network/timeout error with no HTTP status at all", () => {
    const location = { pathname: "/console/settings", href: "" };
    vi.stubGlobal("window", { location });

    const redirected = redirectIfUnauthorized({ kind: "timeout", message: "the operation timed out", retryable: true });

    expect(redirected).toBe(false);
    expect(location.href).toBe("");
  });
});
