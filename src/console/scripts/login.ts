// Passkey login/enrollment (CONSOLE_SPEC.md §1). The one console page that
// runs with no session yet — everything else assumes one already exists.
// @simplewebauthn/browser's startRegistration/startAuthentication do the
// actual WebAuthn ceremony (navigator.credentials.create/get) and hand back
// exactly the JSON shape src/server/auth/webauthn.ts's verify* functions
// expect, so this file is pure plumbing, no crypto of its own.
import {
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";

const READ_TIMEOUT_MS = 8_000;

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  });
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

function statusEl(): HTMLElement | null {
  return document.getElementById("login-status");
}

/** Where to send the operator after a successful sign-in — honors ?next= (src/console/lib/session-guard.ts sets this when it bounces an expired/missing session here), restricted to same-app paths so this can't become an open redirect. */
function postLoginDestination(): string {
  const next = new URLSearchParams(window.location.search).get("next");
  return next && next.startsWith("/console") && !next.startsWith("//") ? next : "/console";
}

function setStatus(message: string, isError: boolean): void {
  const el = statusEl();
  if (!el) return;
  el.textContent = message;
  el.className = `font-mono text-xs ${isError ? "text-rose" : "text-mercury/70"}`;
}

async function register(token: string): Promise<void> {
  setStatus("Requesting registration options…", false);
  const begin = await postJson<{ options: PublicKeyCredentialCreationOptionsJSON; challengeId: string }>("/auth/passkey/register/begin", { token });

  setStatus("Waiting for your authenticator…", false);
  const response = await startRegistration({ optionsJSON: begin.options });

  setStatus("Verifying…", false);
  await postJson("/auth/passkey/register/finish", { challengeId: begin.challengeId, response, label: "primary" });

  setStatus("Passkey registered. You can now sign in.", false);
}

async function login(): Promise<void> {
  setStatus("Requesting a challenge…", false);
  const begin = await postJson<{ options: PublicKeyCredentialRequestOptionsJSON; challengeId: string }>("/auth/passkey/authenticate/begin");

  setStatus("Waiting for your authenticator…", false);
  const response = await startAuthentication({ optionsJSON: begin.options });

  setStatus("Verifying…", false);
  await postJson("/auth/passkey/authenticate/finish", { challengeId: begin.challengeId, response });

  setStatus("Signed in — redirecting…", false);
  const destination = postLoginDestination();
  // Tells radial-nav.ts to show the full-viewport ring once, right after
  // this sign-in, on the dashboard it's about to land on — consumed and
  // removed there. See RadialNav.astro's header comment for why this
  // replaced always server-rendering the dashboard expanded.
  if (destination === "/console" || destination === "/console/") {
    window.sessionStorage.setItem("mythos-console-just-signed-in", "1");
  }

  // Let the glass hero clear before navigating, so the dispersal is seen
  // rather than cut off mid-flight by the page change. Bounded: if the
  // shader never mounted (no WebGL, reduced motion, missing tokens) nothing
  // answers, and the race resolves on the timeout instead of hanging here.
  document.dispatchEvent(new CustomEvent("mythos:signed-in"));
  await Promise.race([
    new Promise<void>((resolve) => document.addEventListener("mythos:glass-cleared", () => resolve(), { once: true })),
    new Promise<void>((resolve) => window.setTimeout(resolve, 1_800)),
  ]);

  window.location.href = destination;
}

export function initLogin(): void {
  document.getElementById("login-register-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const token = (document.getElementById("enrollment-token") as HTMLInputElement | null)?.value.trim();
    if (!token) return;
    void register(token).catch((cause) => setStatus(cause instanceof Error ? cause.message : String(cause), true));
  });

  document.getElementById("login-signin-button")?.addEventListener("click", () => {
    void login().catch((cause) => setStatus(cause instanceof Error ? cause.message : String(cause), true));
  });
}
