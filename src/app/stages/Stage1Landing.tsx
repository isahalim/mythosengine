/**
 * Stage 1 — the landing (board 1).
 *
 * White ground, the spheres drifting behind it, the shattered pane
 * carrying the slogan, and one button at the bottom: "sign in (enable
 * passkey) to start."
 *
 * @simplewebauthn/browser runs the actual WebAuthn ceremony
 * (navigator.credentials.create/get) and hands back exactly the JSON shape
 * src/server/auth/webauthn.ts's verify* functions expect, so this file is
 * plumbing with no crypto of its own.
 */
import { useCallback, useState } from "react";
import {
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import { ShardPane } from "../glass/ShardPane.tsx";
import type { SetKey } from "../glass/geometry.ts";
import { Button } from "../ui/Button.tsx";

const CEREMONY_TIMEOUT_MS = 8_000;

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(CEREMONY_TIMEOUT_MS),
  });
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

interface Stage1Props {
  setKey: SetKey;
  onSignedIn: () => void;
}

export function Stage1Landing({ setKey, onSignedIn }: Stage1Props) {
  const [status, setStatus] = useState<{ message: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [token, setToken] = useState("");

  const say = (message: string, error = false): void => setStatus({ message, error });

  const signIn = useCallback(async () => {
    setBusy(true);
    try {
      say("Requesting a challenge…");
      const begin = await postJson<{ options: PublicKeyCredentialRequestOptionsJSON; challengeId: string }>("/auth/passkey/authenticate/begin");

      say("Waiting for your authenticator…");
      const response = await startAuthentication({ optionsJSON: begin.options });

      say("Verifying…");
      await postJson("/auth/passkey/authenticate/finish", { challengeId: begin.challengeId, response });

      say("Signed in.");
      onSignedIn();
    } catch (cause) {
      say(cause instanceof Error ? cause.message : String(cause), true);
    } finally {
      setBusy(false);
    }
  }, [onSignedIn]);

  const enroll = useCallback(async () => {
    const trimmed = token.trim();
    if (trimmed === "") return;
    setBusy(true);
    try {
      say("Requesting registration options…");
      const begin = await postJson<{ options: PublicKeyCredentialCreationOptionsJSON; challengeId: string }>("/auth/passkey/register/begin", {
        token: trimmed,
      });

      say("Waiting for your authenticator…");
      const response = await startRegistration({ optionsJSON: begin.options });

      say("Verifying…");
      await postJson("/auth/passkey/register/finish", { challengeId: begin.challengeId, response, label: "primary" });

      say("Passkey registered — you can sign in now.");
      setEnrolling(false);
      setToken("");
    } catch (cause) {
      say(cause instanceof Error ? cause.message : String(cause), true);
    } finally {
      setBusy(false);
    }
  }, [token]);

  return (
    <div className="relative z-10 flex h-dvh flex-col">
      <header className="resolve-in flex shrink-0 items-center justify-between px-6 pt-6 sm:px-10">
        <span className="font-display text-sm font-semibold tracking-tight text-mercury">Mythos Engine</span>
        <span className="hidden font-mono text-[0.62rem] uppercase tracking-[0.2em] text-bone sm:inline">Autonomous · Human-reviewed</span>
      </header>

      {/* The hero. The slogan lives inside the glass, physically broken
          across the fragments — board 1: "slogan: shatter into reality." */}
      <div className="min-h-0 flex-1">
        <ShardPane title="shatter into reality." setKey={setKey} className="h-full" />
      </div>

      <div className="resolve-in flex shrink-0 flex-col items-center gap-3 px-6 pb-10 sm:pb-14" style={{ animationDelay: "900ms" }}>
        {enrolling ? (
          <form
            className="flex flex-col items-center gap-3 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault();
              void enroll();
            }}
          >
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Enrollment token"
              autoComplete="one-time-code"
              className="w-64 rounded-full border border-hairline bg-ink px-4 py-2.5 font-mono text-xs text-mercury shadow-[var(--shadow-1)] outline-none placeholder:text-bone/60 focus-visible:border-violet"
            />
            <Button type="submit" variant="primary" disabled={busy || token.trim() === ""}>
              Register passkey
            </Button>
            <Button type="button" variant="ghost" onClick={() => setEnrolling(false)} disabled={busy}>
              Cancel
            </Button>
          </form>
        ) : (
          <>
            <Button variant="primary" className="!px-7 !py-3 !text-base" onClick={() => void signIn()} disabled={busy}>
              {busy ? "Waiting for your authenticator…" : "Sign in with passkey"}
            </Button>
            <button
              type="button"
              className="text-xs text-bone underline-offset-4 transition-colors hover:text-mercury hover:underline"
              onClick={() => {
                setEnrolling(true);
                setStatus(null);
              }}
            >
              First time here? Enrol a passkey
            </button>
          </>
        )}

        {/* A failed ceremony is shown verbatim. It is never swallowed and
            never replaced with a friendlier fiction — the operator needs
            to know whether this was a cancelled prompt, a closed
            enrollment, or the API being unreachable. */}
        <p
          role="status"
          aria-live="polite"
          className={`min-h-4 font-mono text-[0.68rem] ${status?.error === true ? "text-rose" : "text-bone"}`}
        >
          {status?.message ?? ""}
        </p>
      </div>
    </div>
  );
}
