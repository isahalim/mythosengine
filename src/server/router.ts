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
import { discardExport, downloadExport, exportFileName, getExportMetadata, listExports, markExportReviewed, type ExportBlobStore, type ExportStatus } from "./console/exports.ts";
import type { ExportStores } from "./console/exports.ts";
import { rotateProviderKey, ROTATABLE_KEY_NAMES, type RotatableKeyName } from "./console/keys.ts";
import { DEFAULT_RENDER_REF, DEFAULT_RENDER_WORKFLOW, dispatchRun } from "./console/dispatch.ts";
import { createGithubActionsDriver, type GithubActionsDriver } from "../lib/drivers/github-actions.ts";
import { setPipelineEnabled } from "./console/killswitch.ts";
import { approveScript } from "./console/scripts.ts";
import { getRunProgress, listRecentRuns } from "./console/runs.ts";
import { isTopic, rankIdeas } from "./console/ideas.ts";
import { cancelPlanPick, listPlan, queuePlan, queuedSignalIds } from "./console/run-plan.ts";
import { getExportPreviews, getRunMontage } from "./console/montage.ts";
import { handleD1Batch } from "./internal/d1-batch.ts";
import { handleExportBlob } from "./internal/export-blob.ts";
import { log } from "./log.ts";
import type { KvLike } from "../lib/drivers/cache-kv.ts";
import type { VaultKv } from "../lib/vault.ts";

export interface RouterEnv {
  DB: D1Database;
  HOT: KVNamespace;
  VAULT: KVNamespace;
  VAULT_MASTER_KEY: string;
  SESSION_SIGNING_KEY: string;
  CONSOLE_ENROLLMENT_TOKEN: string;
  /** Optional — Pexels supplies the run view's *preview* montage only (src/server/console/montage.ts). Unset means no montage, never a broken console. */
  PEXELS_API_KEY?: string;
  /** Shared secret for POST /internal/d1/batch. Optional in the type, fail-closed in the handler: an unset secret must close the endpoint, never open it. */
  PIPELINE_BATCH_TOKEN?: string;
  /**
   * Fine-grained PAT with Actions: read and write on GITHUB_REPOSITORY —
   * the credential POST /console/dispatch needs to actually start the
   * RENDER workflow (ARCHITECTURE.md §0: the pipeline runs in GitHub
   * Actions, because a Worker cannot run FFmpeg).
   *
   * Optional, and honestly optional: without it the console records the run
   * and reports it as `not_triggered` rather than pretending to have
   * started one. A Worker secret, not a vault entry — it is infrastructure
   * for this deployment, like SESSION_SIGNING_KEY, not a rotatable provider
   * key the operator manages through the console.
   */
  GITHUB_DISPATCH_TOKEN?: string;
  /** `owner/repo`, from wrangler.toml [vars]. Public configuration, not a secret. */
  GITHUB_REPOSITORY?: string;
  /** The git ref RENDER runs from. Defaults to `main`. */
  GITHUB_RENDER_REF?: string;
  /**
   * Export blobs (rendered MP4s), moved off KV on 2026-08-31 because KV caps
   * one value at 25 MiB and a 128s render is ~42 MB. Optional in the type so
   * a Worker deployed without the binding refuses the write with a reason
   * rather than failing to boot — but there is no KV fallback: falling back
   * would restore the ceiling this exists to escape.
   */
  EXPORTS?: R2Bucket;
}

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
  pexelsApiKeyFallback: string | undefined;
  pipelineBatchToken: string | undefined;
  /** Null when no dispatch credential is configured — POST /console/dispatch then records without triggering, and says so. */
  actions: GithubActionsDriver | null;
  renderWorkflow: string;
  renderRef: string;
  /** Undefined when this Worker has no EXPORTS binding — the export routes then say so rather than guessing. */
  exportBucket: R2Bucket | undefined;
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
    pexelsApiKeyFallback: env.PEXELS_API_KEY,
    pipelineBatchToken: env.PIPELINE_BATCH_TOKEN,
    actions: createGithubActionsDriver(env.GITHUB_DISPATCH_TOKEN, env.GITHUB_REPOSITORY),
    exportBucket: env.EXPORTS,
    renderWorkflow: DEFAULT_RENDER_WORKFLOW,
    renderRef: env.GITHUB_RENDER_REF ?? DEFAULT_RENDER_REF,
  };
}

/**
 * The one route this router owns that a browser reaches by **navigating** to
 * it rather than fetching it. The app renders it as a plain `<a href>`
 * on purpose (`src/app/api.ts`: "never needs a client-side fetch"),
 * and it answers with `video/mp4` — never JSON. So it can never satisfy the
 * "does this GET actually want JSON" test below, and has to be named as an
 * exception to it.
 *
 * Getting that wrong is what made the Download button 404: a navigation
 * sends `Accept: text/html,...`, the test sent the request on to the static
 * asset handler, and the asset handler has no such file (2026-08-31).
 */
const EXPORT_DOWNLOAD_PATTERN = /^\/console\/exports\/([^/]+)\/download$/;

/** The guided run's two per-run reads (src/server/console/runs.ts, montage.ts). The montage pattern is tested first, since `/runs/:id` would otherwise swallow it. */
const RUN_PROGRESS_PATTERN = /^\/console\/runs\/([^/]+)$/;
const RUN_MONTAGE_PATTERN = /^\/console\/runs\/([^/]+)\/montage$/;
/** One queued pick, cancellable while it is still queued (db/run-picks.ts). */
const RUN_PLAN_PICK_PATTERN = /^\/console\/run-plan\/([^/]+)$/;

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
  // The pipeline's door to the export blob store (internal/export-blob.ts).
  // Same shared secret as the batch endpoint above, and here for the same
  // reason: the Actions runner has no Worker bindings, and its Cloudflare
  // token has no R2 permission, so the Worker performs the write.
  const exportBlobMatch = pathname.match(/^\/internal\/(exports\/[^/]+)$/);
  if (exportBlobMatch && (method === "PUT" || method === "DELETE")) {
    return handleExportBlob(request, exportBlobMatch[1], {
      db: deps.db,
      exportBucket: deps.exportBucket,
      pipelineBatchToken: deps.pipelineBatchToken,
    });
  }

  // Nothing else lives under /internal/ — say so rather than falling
  // through to the static asset handler, which would answer a probe of this
  // prefix with the console's HTML.
  if (pathname.startsWith("/internal/")) return json({ error: "not_found" }, 404);

  // Every /console/* GET here is an API call, and the app is a single
  // client-rendered page at "/" (src/pages/index.astro) — there are no
  // Astro pages under /console/ any more, since the six-stage overhaul
  // (2026-08-31) collapsed them all into that one route. The Accept test
  // stays anyway: it is what keeps a stray browser navigation to an API
  // path falling through to the static asset handler rather than being
  // answered with JSON, and the download route below has to be named as
  // an exception to it because a navigation asks for text/html.
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

    // ---- the guided run's first three steps: count, topic, ranked ideas ----
    // The ideas endpoint is a read over the signals corpus (BM25, no model
    // call — src/server/console/ideas.ts). The plan endpoints are the only
    // *write* the run view owns, and they write to a queue RENDER claims
    // from; nothing here triggers a render itself.
    if (pathname === "/console/ideas" && method === "GET") {
      const topic = url.searchParams.get("topic") ?? "";
      if (!isTopic(topic)) return json({ error: "unknown_topic" }, 422);
      const limitParam = Number(url.searchParams.get("limit") ?? 5);
      const limit = Number.isFinite(limitParam) ? Math.min(Math.max(Math.trunc(limitParam), 1), 20) : 5;
      // Whatever the operator picked earlier in this same wizard, plus
      // whatever is already queued from a previous one: neither should be
      // offered again, or one run makes two videos about one story.
      const exclude = [...(url.searchParams.get("exclude")?.split(",").filter((id) => id !== "") ?? []), ...(await queuedSignalIds(ctx.db))];
      return json(await rankIdeas(ctx.db, topic, limit, exclude));
    }

    if (pathname === "/console/run-plan" && method === "GET") {
      return json(await listPlan(ctx.db));
    }

    if (pathname === "/console/run-plan" && method === "POST") {
      const body = await readJson(request);
      if (!body.ok) return json({ error: "invalid_json" }, 400);
      const result = await queuePlan(ctx.db, ctx.rawClient, body.value);
      if (result.kind === "invalid") return json({ error: "invalid_plan", message: result.message }, 422);
      if (result.kind === "unknown_signal") return json({ error: "unknown_signal", signalIds: result.signalIds }, 422);
      if (result.kind === "not_eligible") return json({ error: "not_eligible", signalIds: result.signalIds }, 409);
      await writeAuditLog(ctx.db, "human", "run.plan", result.planId, { queued: result.queued });
      return json({ ok: true, planId: result.planId, queued: result.queued });
    }

    const cancelPickMatch = pathname.match(RUN_PLAN_PICK_PATTERN);
    if (cancelPickMatch && method === "DELETE") {
      const result = await cancelPlanPick(ctx.db, cancelPickMatch[1]);
      if (result.kind === "not_found") return json({ error: "not_found" }, 404);
      await writeAuditLog(ctx.db, "human", "run.plan.cancel", cancelPickMatch[1], {});
      return json({ ok: true });
    }

    // ---- the guided run (plan v2 §7 steps 4 and 5) ----
    // Read-only, all three: the run view watches what the pipeline is
    // doing, it does not steer it. Starting a run is still POST
    // /console/dispatch, and the export actions are still the export
    // routes below — no second write path for either.
    if (pathname === "/console/runs" && method === "GET") {
      return json(await listRecentRuns(ctx.db));
    }

    const runMontageMatch = pathname.match(RUN_MONTAGE_PATTERN);
    if (runMontageMatch && method === "GET") {
      const montage = await getRunMontage(ctx.db, ctx.hotKv, ctx.vaultKv, deps.vaultMasterKey, deps.pexelsApiKeyFallback, runMontageMatch[1]);
      if (montage === null) return json({ error: "not_found" }, 404);
      return json(montage);
    }

    const runProgressMatch = pathname.match(RUN_PROGRESS_PATTERN);
    if (runProgressMatch && method === "GET") {
      const progress = await getRunProgress(ctx.db, runProgressMatch[1]);
      if (progress === null) return json({ error: "not_found" }, 404);
      return json(progress);
    }

    if (pathname === "/console/exports" && method === "GET") {
      const status = url.searchParams.get("status") as ExportStatus | null;
      return json(await listExports(ctx.db, status ?? undefined));
    }

    // Stage 6's sneak peeks. Registered ahead of the `:id` export routes
    // because "previews" would otherwise be read as an export id — it
    // cannot collide today (the id routes all carry a trailing verb) but
    // the ordering is what keeps that true when one of them stops doing so.
    //
    // Reads the same live list the stage renders, so the previews can never
    // describe a different set of exports than the one on screen; discarded
    // and expired rows are dropped because nothing shows them.
    if (pathname === "/console/exports/previews" && method === "GET") {
      const live = (await listExports(ctx.db)).filter((row) => row.status !== "discarded" && row.status !== "expired");
      return json(
        await getExportPreviews(
          ctx.hotKv,
          ctx.vaultKv,
          deps.vaultMasterKey,
          deps.pexelsApiKeyFallback,
          live.map((row) => ({ id: row.id, keywords: row.keywords })),
        ),
      );
    }

    // The upload sheet: description, hashtags, and every clip in the video
    // with the source it came from and the span of that source it used.
    // Registered before the id-matching routes below for the same reason
    // "previews" is — the ordering is what keeps a literal path from being
    // read as an export id.
    const metadataMatch = pathname.match(/^\/console\/exports\/([^/]+)\/metadata$/);
    if (metadataMatch && method === "GET") {
      const metadata = await getExportMetadata(ctx.db, metadataMatch[1]);
      if (metadata === null) return json({ error: "not_found" }, 404);
      return json(metadata);
    }

    // Both halves, because export blobs moved from KV to R2 on 2026-08-31
    // and the rows written before that are still downloadable. Which one a
    // given export uses is read off its storage key, never assumed.
    const exportStores: ExportStores = { kv: ctx.hotKv, r2: deps.exportBucket };

    const downloadMatch = pathname.match(EXPORT_DOWNLOAD_PATTERN);
    if (downloadMatch && method === "GET") {
      const result = await downloadExport(ctx.db, exportStores, downloadMatch[1]);
      if (result.kind === "not_found") return json({ error: "not_found" }, 404);
      if (result.kind === "blob_missing") return json({ error: "blob_missing" }, 410);
      if (result.kind === "no_blob_store") return json({ error: "not_configured", detail: "this Worker has no EXPORTS R2 binding" }, 503);
      await writeAuditLog(ctx.db, "human", "export.download", downloadMatch[1], {});
      // `attachment` is what makes this a download rather than a video that
      // opens in the tab and plays. The button says Download; without this
      // header Chrome navigates and plays it, which is not what a reviewer
      // asked for and leaves them with no file.
      return new Response(result.body, {
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
      const result = await discardExport(ctx.db, exportStores, discardMatch[1]);
      if (result.kind === "not_found") return json({ error: "not_found" }, 404);
      if (result.kind === "no_blob_store") return json({ error: "not_configured", detail: "this Worker has no EXPORTS R2 binding" }, 503);
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
      const result = await dispatchRun(ctx.db, ctx.hotKv, { actions: deps.actions, workflow: deps.renderWorkflow, ref: deps.renderRef });
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
