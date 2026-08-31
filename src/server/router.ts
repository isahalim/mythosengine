import type { RegistrationResponseJSON, AuthenticationResponseJSON } from "@simplewebauthn/server";
import { createD1Db, type AppDb, type RawSqlClient } from "../../db/client.ts";
import {
  beginAuthentication,
  beginReauth,
  beginRegistration,
  finishAuthentication,
  finishReauth,
  finishRegistration,
  type RpConfig,
} from "./auth/webauthn.ts";
import { buildSessionClearCookie, buildSessionCookie, getSession, issueSessionToken, SESSION_COOKIE_NAME } from "./auth/session.ts";
import { consumeReauthNonce, issueReauthNonce } from "./auth/reauth.ts";
import { writeAuditLog } from "./audit.ts";
import { DirectiveSchema } from "./console/directive-schema.ts";
import { compileDirectiveFromRawText, dryRunSettings, getSettings, resetToDefaults, updateSettings } from "./console/settings.ts";
import { discardExport, downloadExport, exportFileName, listExports, markExportReviewed, type ExportBlobStore, type ExportStatus } from "./console/exports.ts";
import { rotateProviderKey, ROTATABLE_KEY_NAMES, type RotatableKeyName } from "./console/keys.ts";
import { dispatchRun } from "./console/dispatch.ts";
import { setPipelineEnabled } from "./console/killswitch.ts";
import { approveScript } from "./console/scripts.ts";
import { getConsoleSummary } from "./console/summary.ts";
import { createChatSession, deleteChatSession, getChatMessages, listChatSessions } from "./console/chat.ts";
import { runAgentTurn, type ToolInvoker } from "./agent/loop.ts";
import { issueMcpToken, listMcpTokens, revokeMcpToken, verifyMcpToken } from "./mcp/tokens.ts";
import { handleD1Batch } from "./internal/d1-batch.ts";
import { callMcpTool, handleMcpRequest } from "./mcp/server.ts";
import { log } from "./log.ts";
import type { KvLike } from "../lib/drivers/cache-kv.ts";
import type { VaultKv } from "../lib/vault.ts";
import { createGroqDriverFromVault, createGroqLimiter, createGroqWhisperDriverFromVault } from "../lib/drivers/resolve-groq-driver.ts";

export interface RouterEnv {
  DB: D1Database;
  HOT: KVNamespace;
  VAULT: KVNamespace;
  VAULT_MASTER_KEY: string;
  SESSION_SIGNING_KEY: string;
  CONSOLE_ENROLLMENT_TOKEN: string;
  GROQ_API_KEY: string;
  /** Shared secret for POST /internal/d1/batch. Optional in the type, fail-closed in the handler: an unset secret must close the endpoint, never open it. */
  PIPELINE_BATCH_TOKEN?: string;
}

// Shared across requests within one Worker isolate's lifetime — same
// "one shared instance serializes every Groq call" reasoning
// TokenBucketLimiter's own docstring states (src/lib/drivers/rate-limiter.ts).
// A fresh isolate gets a fresh bucket, which is the same cold-start
// behavior every other in-memory rate limit in a Workers app has — and the
// reason this cannot be the only defense against a 429 (see http.ts).
// Budget now derives from QUOTAS.groq (src/config/quotas.ts) rather than
// the hard-coded 28/4500 that used to sit here, which had drifted from both
// the config and Groq's real 30/8000.
const groqLimiter = createGroqLimiter();

/** The exact slice of a KV namespace the export blob store needs, layered onto plain KvLike. */
export type HotKvLike = KvLike & ExportBlobStore;

/**
 * Everything the router needs, expressed as the minimal structural
 * interfaces each dependency actually uses (same "the slice of the binding
 * this needs" pattern as src/lib/drivers/cache-kv.ts's KvLike) rather than
 * the full D1Database/KVNamespace types — a real Worker binding satisfies
 * these trivially, and so does a small in-memory test double, with no cast
 * needed in either direction. `routeRequest` (below) is the thin production
 * wrapper that builds this from a real Env; tests call `handleApiRequest`
 * directly with their own doubles.
 */
export interface RouterDeps {
  db: AppDb;
  rawClient: RawSqlClient;
  hotKv: HotKvLike;
  vaultKv: VaultKv;
  vaultMasterKey: string;
  sessionSigningKey: string;
  consoleEnrollmentToken: string;
  groqApiKeyFallback: string;
  pipelineBatchToken: string | undefined;
}

function depsFromEnv(env: RouterEnv): RouterDeps {
  return {
    db: createD1Db(env.DB),
    rawClient: env.DB,
    hotKv: env.HOT,
    vaultKv: env.VAULT,
    vaultMasterKey: env.VAULT_MASTER_KEY,
    sessionSigningKey: env.SESSION_SIGNING_KEY,
    consoleEnrollmentToken: env.CONSOLE_ENROLLMENT_TOKEN,
    groqApiKeyFallback: env.GROQ_API_KEY,
    pipelineBatchToken: env.PIPELINE_BATCH_TOKEN,
  };
}

/**
 * The one route this router owns that a browser reaches by **navigating** to
 * it rather than fetching it. The console renders it as a plain `<a href>`
 * on purpose (`src/console/lib/api.ts`: "never needs a client-side fetch"),
 * and it answers with `video/mp4` — never JSON. So it can never satisfy the
 * "does this GET actually want JSON" test below, and has to be named as an
 * exception to it.
 *
 * Getting that wrong is what made the Download button 404: a navigation
 * sends `Accept: text/html,...`, the test sent the request on to the static
 * asset handler, and the asset handler has no such file (2026-08-31).
 */
const EXPORT_DOWNLOAD_PATTERN = /^\/console\/exports\/([^/]+)\/download$/;

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function rpConfigFor(url: URL): RpConfig {
  return { rpID: url.hostname, origin: url.origin };
}

async function readJson(request: Request): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: await request.json() };
  } catch {
    return { ok: false };
  }
}

/** Session-protected: every /console/* route needs a valid session; returns 401 otherwise. */
async function requireSession(request: Request, deps: RouterDeps): Promise<{ sessionId: string } | Response> {
  const session = await getSession(request, deps.sessionSigningKey);
  if (!session) return json({ error: "unauthorized" }, 401);
  return { sessionId: session.sessionId };
}

/** CONSOLE_SPEC.md §1/§2: key rotation and the killswitch require a fresh (<5min) WebAuthn assertion. */
async function requireReauth(request: Request, ctx: RouterDeps, sessionId: string): Promise<true | Response> {
  const nonce = request.headers.get("x-reauth-nonce");
  if (!nonce) return json({ error: "reauth_required" }, 401);
  const ok = await consumeReauthNonce(ctx.db, nonce, sessionId);
  if (!ok) return json({ error: "reauth_required" }, 401);
  return true;
}

function isResponse(value: unknown): value is Response {
  return value instanceof Response;
}

/**
 * Handles every `/auth/*` and `/console/*` route (ARCHITECTURE.md §6). Returns
 * null for any other path so src/index.ts falls through to serving static
 * assets — this router owns exactly the API surface, nothing else. Pure
 * function of its dependencies (see RouterDeps) — production wires it to a
 * real Env via routeRequest below; tests call this directly with doubles.
 */
export async function handleApiRequest(request: Request, deps: RouterDeps): Promise<Response | null> {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;

  if (!pathname.startsWith("/auth/") && !pathname.startsWith("/console/") && !pathname.startsWith("/internal/")) return null;

  // The machine-to-machine surface, handled before every console concern
  // below: no session, no cookie, no reauth nonce, and deliberately not
  // reachable by any of the console's own paths. Its own bearer secret is
  // checked inside the handler, which fails closed when that secret is
  // unset (src/server/internal/d1-batch.ts).
  if (pathname === "/internal/d1/batch" && method === "POST") {
    return handleD1Batch(request, { db: deps.db, rawClient: deps.rawClient, pipelineBatchToken: deps.pipelineBatchToken });
  }
  // Nothing else lives under /internal/ — say so rather than falling
  // through to the static asset handler, which would answer a probe of this
  // prefix with the console's HTML.
  if (pathname.startsWith("/internal/")) return json({ error: "not_found" }, 404);

  // /console/settings is both an Astro page (src/pages/console/settings.astro)
  // and a JSON API route (GET /console/settings, ARCHITECTURE.md §6) at the
  // identical path — the only such collision among the routes this file
  // owns. A GET is only ever an API call when the caller actually wants
  // JSON; src/console/lib/api.ts's get() sends this header for exactly that
  // reason. A plain browser navigation has no such header, so it falls
  // through to env.ASSETS untouched.
  if (method === "GET" && !EXPORT_DOWNLOAD_PATTERN.test(pathname) && !(request.headers.get("accept") ?? "").includes("application/json")) return null;

  const ctx = deps;
  const rp = rpConfigFor(url);

  try {
    // ---- /auth/passkey/* (no session required — these establish one) ----
    if (pathname === "/auth/passkey/register/begin" && method === "POST") {
      const body = await readJson(request);
      if (!body.ok) return json({ error: "invalid_json" }, 400);
      const { token } = body.value as { token?: string };
      const result = await beginRegistration(ctx.db, rp, token ?? "", deps.consoleEnrollmentToken);
      if (result.kind === "enrollment_closed") return json({ error: "enrollment_closed" }, 410);
      if (result.kind === "invalid_token") return json({ error: "invalid_token" }, 401);
      return json({ options: result.options, challengeId: result.challengeId });
    }

    if (pathname === "/auth/passkey/register/finish" && method === "POST") {
      const body = await readJson(request);
      if (!body.ok) return json({ error: "invalid_json" }, 400);
      const { challengeId, response, label } = body.value as { challengeId?: string; response?: RegistrationResponseJSON; label?: string };
      if (!challengeId || !response) return json({ error: "invalid_request" }, 400);
      const result = await finishRegistration(ctx.db, rp, challengeId, response, label ?? "passkey");
      if (result.kind !== "ok") return json({ error: result.kind }, 400);
      await writeAuditLog(ctx.db, "human", "passkey.register", "credentials", { credentialCount: result.credentialCount });
      return json({ ok: true, credentialCount: result.credentialCount });
    }

    if (pathname === "/auth/passkey/authenticate/begin" && method === "POST") {
      const result = await beginAuthentication(ctx.db, rp);
      return json({ options: result.options, challengeId: result.challengeId });
    }

    if (pathname === "/auth/passkey/authenticate/finish" && method === "POST") {
      const body = await readJson(request);
      if (!body.ok) return json({ error: "invalid_json" }, 400);
      const { challengeId, response } = body.value as { challengeId?: string; response?: AuthenticationResponseJSON };
      if (!challengeId || !response) return json({ error: "invalid_request" }, 400);
      const result = await finishAuthentication(ctx.db, rp, challengeId, response);
      if (result.kind !== "ok") return json({ error: result.kind }, 401);

      const sessionId = crypto.randomUUID();
      const token = await issueSessionToken(sessionId, deps.sessionSigningKey);
      await writeAuditLog(ctx.db, "human", "passkey.authenticate", sessionId, {});
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json", "set-cookie": buildSessionCookie(token) },
      });
    }

    // POST /console/mcp accepts EITHER the console's own session cookie
    // (same-origin use, e.g. the in-console voice surface) OR a bearer
    // token (external MCP clients — Claude Desktop, Claude Code) verified
    // against mcp_tokens — the one /console/* route that isn't
    // session-only, so it's handled before the blanket requireSession gate
    // below. Reuses ctx.hotKv/vaultKv/vaultMasterKey exactly like AGENT_TOOLS
    // does elsewhere — no second tool implementation, no separate audit path.
    if (pathname === "/console/mcp" && method === "POST") {
      const authHeader = request.headers.get("authorization");
      let callerLabel: string;
      if (authHeader?.startsWith("Bearer ")) {
        const tokenId = await verifyMcpToken(ctx.db, authHeader.slice("Bearer ".length));
        if (!tokenId) return json({ error: "unauthorized" }, 401);
        callerLabel = `token:${tokenId}`;
      } else {
        const mcpSession = await requireSession(request, deps);
        if (isResponse(mcpSession)) return mcpSession;
        callerLabel = `session:${mcpSession.sessionId}`;
      }

      const body = await readJson(request);
      if (!body.ok) return json({ error: "invalid_json" }, 400);
      const toolCtx = { db: ctx.db, rawClient: ctx.rawClient, hotKv: ctx.hotKv, vaultKv: ctx.vaultKv, vaultMasterKey: ctx.vaultMasterKey };
      return handleMcpRequest(body.value, toolCtx, callerLabel);
    }

    // Everything past this point requires a session.
    const session = await requireSession(request, deps);
    if (isResponse(session)) return session;
    const { sessionId } = session;

    if (pathname === "/auth/passkey/logout" && method === "POST") {
      await writeAuditLog(ctx.db, "human", "passkey.logout", sessionId, {});
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json", "set-cookie": buildSessionClearCookie() },
      });
    }

    if (pathname === "/auth/passkey/reauth/begin" && method === "POST") {
      const result = await beginReauth(ctx.db, rp, sessionId);
      return json({ options: result.options, challengeId: result.challengeId });
    }

    if (pathname === "/auth/passkey/reauth/finish" && method === "POST") {
      const body = await readJson(request);
      if (!body.ok) return json({ error: "invalid_json" }, 400);
      const { challengeId, response } = body.value as { challengeId?: string; response?: AuthenticationResponseJSON };
      if (!challengeId || !response) return json({ error: "invalid_request" }, 400);
      const result = await finishReauth(ctx.db, rp, challengeId, response);
      if (result.kind !== "ok" || result.sessionId !== sessionId) return json({ error: "reauth_failed" }, 401);
      const nonce = await issueReauthNonce(ctx.db, sessionId);
      return json({ reauthNonce: nonce });
    }

    if (pathname === "/console/summary" && method === "GET") {
      const summary = await getConsoleSummary(ctx.db, ctx.hotKv, ctx.vaultKv, deps.vaultMasterKey);
      return json(summary);
    }

    if (pathname === "/console/exports" && method === "GET") {
      const status = url.searchParams.get("status") as ExportStatus | null;
      return json(await listExports(ctx.db, status ?? undefined));
    }

    const downloadMatch = pathname.match(EXPORT_DOWNLOAD_PATTERN);
    if (downloadMatch && method === "GET") {
      const result = await downloadExport(ctx.db, ctx.hotKv, downloadMatch[1]);
      if (result.kind === "not_found") return json({ error: "not_found" }, 404);
      if (result.kind === "blob_missing") return json({ error: "blob_missing" }, 410);
      await writeAuditLog(ctx.db, "human", "export.download", downloadMatch[1], {});
      // `attachment` is what makes this a download rather than a video that
      // opens in the tab and plays. The button says Download; without this
      // header Chrome navigates and plays it, which is not what a reviewer
      // asked for and leaves them with no file.
      return new Response(result.bytes, {
        headers: {
          "content-type": "video/mp4",
          "content-disposition": `attachment; filename="${exportFileName(result.export.suggestedTitle, result.export.id)}"`,
        },
      });
    }

    const reviewMatch = pathname.match(/^\/console\/exports\/([^/]+)\/mark-reviewed$/);
    if (reviewMatch && method === "POST") {
      const result = await markExportReviewed(ctx.db, reviewMatch[1]);
      if (result.kind === "not_found") return json({ error: "not_found" }, 404);
      await writeAuditLog(ctx.db, "human", "export.mark_reviewed", reviewMatch[1], {});
      return json({ ok: true });
    }

    const discardMatch = pathname.match(/^\/console\/exports\/([^/]+)\/discard$/);
    if (discardMatch && method === "POST") {
      const result = await discardExport(ctx.db, ctx.hotKv, discardMatch[1]);
      if (result.kind === "not_found") return json({ error: "not_found" }, 404);
      await writeAuditLog(ctx.db, "human", "export.discard", discardMatch[1], {});
      return json({ ok: true });
    }

    if (pathname === "/console/settings" && method === "GET") {
      const settings = await getSettings(ctx.db);
      return json(settings ?? { error: "not_configured" }, settings ? 200 : 404);
    }

    if (pathname === "/console/settings" && method === "PUT") {
      const body = await readJson(request);
      if (!body.ok) return json({ error: "invalid_json" }, 400);
      const parsed = DirectiveSchema.safeParse(body.value);
      if (!parsed.success) return json({ error: "invalid_directive", issues: parsed.error.issues }, 400);
      const settings = await updateSettings(ctx.db, ctx.rawClient, parsed.data, "");
      await writeAuditLog(ctx.db, "human", "settings.update", String(settings.version), { directive: parsed.data });
      return json(settings);
    }

    if (pathname === "/console/settings/dry-run" && method === "POST") {
      const body = await readJson(request);
      if (!body.ok) return json({ error: "invalid_json" }, 400);
      const parsed = DirectiveSchema.safeParse(body.value);
      if (!parsed.success) return json({ error: "invalid_directive", issues: parsed.error.issues }, 400);
      return json(await dryRunSettings(ctx.db, parsed.data));
    }

    if (pathname === "/console/settings/reset-defaults" && method === "POST") {
      const settings = await resetToDefaults(ctx.db, ctx.rawClient);
      await writeAuditLog(ctx.db, "human", "settings.reset_defaults", String(settings.version), {});
      return json(settings);
    }

    if (pathname === "/console/directive" && method === "POST") {
      const body = await readJson(request);
      if (!body.ok) return json({ error: "invalid_json" }, 400);
      const { rawText } = body.value as { rawText?: string };
      if (typeof rawText !== "string") return json({ error: "invalid_request" }, 400);
      const current = await getSettings(ctx.db);
      const compiled = compileDirectiveFromRawText(current?.directive ?? null, rawText);
      const settings = await updateSettings(ctx.db, ctx.rawClient, compiled, rawText);
      await writeAuditLog(ctx.db, "human", "settings.update_from_directive", String(settings.version), { rawText });
      return json(settings);
    }

    const keyMatch = pathname.match(/^\/console\/keys\/([^/]+)$/);
    if (keyMatch && method === "POST") {
      const reauth = await requireReauth(request, ctx, sessionId);
      if (isResponse(reauth)) return reauth;

      const name = keyMatch[1] as RotatableKeyName;
      if (!(ROTATABLE_KEY_NAMES as readonly string[]).includes(name)) return json({ error: "unknown_key" }, 404);
      const body = await readJson(request);
      if (!body.ok) return json({ error: "invalid_json" }, 400);
      const { value } = body.value as { value?: string };
      if (typeof value !== "string") return json({ error: "invalid_request" }, 400);

      const result = await rotateProviderKey(ctx.vaultKv, deps.vaultMasterKey, name, value);
      if (result.kind === "invalid_shape") return json({ error: "invalid_shape", message: result.message }, 422);
      if (result.kind === "live_check_failed") return json({ error: "live_check_failed" }, 422);
      await writeAuditLog(ctx.db, "human", "key.rotate", name, { fingerprint: result.fingerprint, validated: true });
      return json({ ok: true, last4: result.last4, fingerprint: result.fingerprint, activeVersion: result.activeVersion });
    }

    if (pathname === "/console/dispatch" && method === "POST") {
      const result = await dispatchRun(ctx.db, ctx.hotKv);
      if (result.kind === "disabled") return json({ error: "pipeline_disabled" }, 409);
      if (result.kind === "rate_limited") return json({ error: "rate_limited" }, 429);
      await writeAuditLog(ctx.db, "human", "pipeline.dispatch", result.runId, {});
      return json({ ok: true, runId: result.runId, note: result.note });
    }

    if (pathname === "/console/killswitch" && method === "POST") {
      const reauth = await requireReauth(request, ctx, sessionId);
      if (isResponse(reauth)) return reauth;

      const body = await readJson(request);
      if (!body.ok) return json({ error: "invalid_json" }, 400);
      const { enabled } = body.value as { enabled?: boolean };
      if (typeof enabled !== "boolean") return json({ error: "invalid_request" }, 400);
      await setPipelineEnabled(ctx.hotKv, enabled);
      await writeAuditLog(ctx.db, "human", "pipeline.killswitch", String(enabled), {});
      return json({ ok: true, enabled });
    }

    const approveMatch = pathname.match(/^\/console\/scripts\/([^/]+)\/approve$/);
    if (approveMatch && method === "POST") {
      const result = await approveScript(ctx.db, approveMatch[1]);
      if (result.kind === "not_found") return json({ error: "not_found" }, 404);
      if (result.kind === "not_draft") return json({ error: "not_draft" }, 409);
      await writeAuditLog(ctx.db, "human", "script.approve", approveMatch[1], {});
      return json({ ok: true });
    }

    // ---- Chat-agent console (Groq tool-calling over the same service layer) ----
    if (pathname === "/console/chat/sessions" && method === "GET") {
      return json(await listChatSessions(ctx.db));
    }

    if (pathname === "/console/chat/sessions" && method === "POST") {
      const session = await createChatSession(ctx.db);
      return json(session, 201);
    }

    const chatDeleteMatch = pathname.match(/^\/console\/chat\/sessions\/([^/]+)$/);
    if (chatDeleteMatch && method === "DELETE") {
      const result = await deleteChatSession(ctx.db, chatDeleteMatch[1]);
      if (result.kind === "not_found") return json({ error: "not_found" }, 404);
      await writeAuditLog(ctx.db, "human", "chat.delete_session", chatDeleteMatch[1], {});
      return json({ ok: true });
    }

    const chatMessagesMatch = pathname.match(/^\/console\/chat\/sessions\/([^/]+)\/messages$/);
    if (chatMessagesMatch && method === "GET") {
      return json(await getChatMessages(ctx.db, chatMessagesMatch[1]));
    }

    const chatSendMatch = pathname.match(/^\/console\/chat\/sessions\/([^/]+)\/message$/);
    if (chatSendMatch && method === "POST") {
      const body = await readJson(request);
      if (!body.ok) return json({ error: "invalid_json" }, 400);
      const { content } = body.value as { content?: string };
      if (typeof content !== "string" || content.trim().length === 0) return json({ error: "invalid_request" }, 400);

      const llm = await createGroqDriverFromVault(ctx.vaultKv, ctx.vaultMasterKey, ctx.groqApiKeyFallback, groqLimiter);
      const toolCtx = { db: ctx.db, rawClient: ctx.rawClient, hotKv: ctx.hotKv, vaultKv: ctx.vaultKv, vaultMasterKey: ctx.vaultMasterKey };
      const result = await runAgentTurn(llm, ctx.db, toolCtx, chatSendMatch[1], content);
      return json(result);
    }

    // ---- MCP access tokens (external clients — Claude Desktop, Claude Code) ----
    if (pathname === "/console/mcp-tokens" && method === "GET") {
      return json(await listMcpTokens(ctx.db));
    }

    if (pathname === "/console/mcp-tokens" && method === "POST") {
      // A live MCP token can call the same AGENT_TOOLS allowlist the chat agent
      // can — credential-equivalent, same reauth bar as key rotation (CONSOLE_SPEC.md §2).
      const reauth = await requireReauth(request, ctx, sessionId);
      if (isResponse(reauth)) return reauth;

      const body = await readJson(request);
      if (!body.ok) return json({ error: "invalid_json" }, 400);
      const { label } = body.value as { label?: string };
      if (typeof label !== "string" || label.trim().length === 0) return json({ error: "invalid_request" }, 400);

      const { token, summary } = await issueMcpToken(ctx.db, label.trim());
      await writeAuditLog(ctx.db, "human", "mcp_token.issue", summary.id, { label: summary.label });
      return json({ token, ...summary }, 201);
    }

    const mcpTokenDeleteMatch = pathname.match(/^\/console\/mcp-tokens\/([^/]+)$/);
    if (mcpTokenDeleteMatch && method === "DELETE") {
      const result = await revokeMcpToken(ctx.db, mcpTokenDeleteMatch[1]);
      if (result.kind === "not_found") return json({ error: "not_found" }, 404);
      await writeAuditLog(ctx.db, "human", "mcp_token.revoke", mcpTokenDeleteMatch[1], {});
      return json({ ok: true });
    }

    // ---- Voice control (Groq Whisper STT + the same AGENT_TOOLS surface, dispatched via MCP) ----
    if (pathname === "/console/voice/transcribe" && method === "POST") {
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.byteLength === 0) return json({ error: "invalid_request" }, 400);

      const asr = await createGroqWhisperDriverFromVault(ctx.vaultKv, ctx.vaultMasterKey, ctx.groqApiKeyFallback);
      const mimeType = request.headers.get("content-type") ?? "audio/webm";
      const result = await asr.transcribe({ source: { kind: "audio", bytes, mimeType } });
      if (!result.ok) return json({ error: result.error.kind, message: result.error.message }, 502);
      return json({ transcript: result.value.transcript });
    }

    const voiceTurnMatch = pathname === "/console/voice/turn";
    if (voiceTurnMatch && method === "POST") {
      const body = await readJson(request);
      if (!body.ok) return json({ error: "invalid_json" }, 400);
      const { sessionId: voiceSessionId, transcript } = body.value as { sessionId?: string; transcript?: string };
      if (typeof transcript !== "string" || transcript.trim().length === 0) return json({ error: "invalid_request" }, 400);

      const activeSessionId = typeof voiceSessionId === "string" && voiceSessionId.length > 0 ? voiceSessionId : (await createChatSession(ctx.db)).id;

      const llm = await createGroqDriverFromVault(ctx.vaultKv, ctx.vaultMasterKey, ctx.groqApiKeyFallback, groqLimiter);
      const toolCtx = { db: ctx.db, rawClient: ctx.rawClient, hotKv: ctx.hotKv, vaultKv: ctx.vaultKv, vaultMasterKey: ctx.vaultMasterKey };
      // Dispatches every tool call through the exact MCP tool contract
      // (src/server/mcp/server.ts's callMcpTool) instead of AGENT_TOOLS
      // directly — this is what makes voice control genuinely "through
      // MCP," audited with actor "mcp" instead of "agent" (docs/DECISIONS.md).
      const mcpInvoker: ToolInvoker = { invoke: (invokerCtx, sid, name, args, now) => callMcpTool(invokerCtx, name, args, `session:${sid}`, now) };
      const result = await runAgentTurn(llm, ctx.db, toolCtx, activeSessionId, transcript, Date.now, mcpInvoker);
      return json({ sessionId: activeSessionId, ...result });
    }

    return json({ error: "not_found" }, 404);
  } catch (cause) {
    log.error({ err: cause instanceof Error ? cause.message : String(cause), pathname, method }, "unhandled router error");
    return json({ error: "internal_error" }, 500);
  }
}

/** Production entry point — builds RouterDeps from a real Env and delegates. */
export function routeRequest(request: Request, env: RouterEnv): Promise<Response | null> {
  return handleApiRequest(request, depsFromEnv(env));
}

export { SESSION_COOKIE_NAME };
