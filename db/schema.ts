import { sql } from "drizzle-orm";
import { blob, check, index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Schema mirrors ARCHITECTURE.md §4 exactly — that doc is the source of
// truth for *why* each constraint exists. Keep them in sync; a schema
// change here without a matching doc update is a bug.

// Drizzle's `{ enum: [...] }` option on text() is TypeScript-only — it does
// NOT emit a SQL CHECK constraint. Every enum-shaped column below gets an
// explicit check() too, so illegal states are unrepresentable at the
// database layer, not just through the ORM (ARCHITECTURE.md §4).

export const sources = sqliteTable(
  "sources",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["reddit", "rss", "x", "youtube_community"] }).notNull(),
    url: text("url").notNull(),
    enabled: integer("enabled").notNull().default(1),
    lastSeenAt: text("last_seen_at"),
    // Conditional-GET cache (ARCHITECTURE.md §5.1) so WATCH burns no
    // bandwidth/quota re-fetching an unchanged feed every run.
    etag: text("etag"),
    lastModified: text("last_modified"),
  },
  (t) => [check("chk_sources_kind", sql`${t.kind} IN ('reddit','rss','x','youtube_community')`)],
);

export const signals = sqliteTable(
  "signals",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    canonicalUrl: text("canonical_url").notNull(),
    title: text("title").notNull(),
    observedAt: text("observed_at").notNull(),
    engagementScore: real("engagement_score").notNull(),
    simhash: text("simhash").notNull(),
    state: text("state", {
      enum: ["observed", "scored", "scripted", "critiqued", "exported", "rejected", "failed"],
    }).notNull(),
    attempts: integer("attempts").notNull().default(0),
  },
  (t) => [
    uniqueIndex("uq_signals_source_url").on(t.sourceId, t.canonicalUrl),
    index("idx_signals_state").on(t.state, t.observedAt),
    check(
      "chk_signals_state",
      sql`${t.state} IN ('observed','scored','scripted','critiqued','exported','rejected','failed')`,
    ),
  ],
);

export const scripts = sqliteTable(
  "scripts",
  {
    id: text("id").primaryKey(),
    signalId: text("signal_id")
      .notNull()
      .references(() => signals.id, { onDelete: "cascade" }),
    hook: text("hook").notNull(),
    body: text("body").notNull(),
    debateQuestion: text("debate_question").notNull(),
    wordCount: integer("word_count").notNull(),
    originalityScore: real("originality_score"),
    status: text("status", { enum: ["draft", "approved", "rejected"] }).notNull(),
    /**
     * The `runs.trace_id` of the pipeline invocation that wrote this script
     * — the one link between a run and the video it is producing
     * (CONSOLE_SPEC.md's guided run, plan v2 §7 step 4).
     *
     * On `scripts` rather than on `renders`, and that placement is the whole
     * point: the waiting screen has to show the operator what the run is
     * building *while it is still building it*, and the render row does not
     * exist until TTS and FFmpeg have both finished — minutes later. The
     * script row appears seconds in, and `renders.script_id` /
     * `exports.render_id` carry the trace forward from there.
     *
     * Nullable: every script written before 2026-08-31 has no trace, and so
     * does any script from a pipeline entrypoint that does not pass one. A
     * run with no scripts attributed to it renders as a run with no videos
     * yet, which is the truth.
     */
    traceId: text("trace_id"),
    // Drives "today's diversity" queries (ARCHITECTURE.md §5.3) — which
    // sources/games/voices today's earlier renders already used.
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    check("chk_scripts_status", sql`${t.status} IN ('draft','approved','rejected')`),
    index("idx_scripts_created").on(t.createdAt),
    index("idx_scripts_trace").on(t.traceId),
  ],
);

/**
 * RESEARCH (ARCHITECTURE.md §5.2.5) — the grounded brief SCRIPT was written
 * from, and the citations it stands on. Kept as its own table rather than a
 * column on `scripts` because it is evidence, not draft content: §9 requires
 * the export's audit package to show a reviewer what the script was
 * grounded in, and a brief survives a script being rewritten.
 *
 * Nullable from the pipeline's point of view — a render whose RESEARCH
 * failed simply has no row here, and AUDIT SUMMARY says so. A retrieval
 * outage degrades the day's video, it does not cancel it.
 */
export const researchBriefs = sqliteTable(
  "research_briefs",
  {
    id: text("id").primaryKey(),
    signalId: text("signal_id")
      .notNull()
      .references(() => signals.id, { onDelete: "cascade" }),
    summary: text("summary").notNull(),
    // JSON arrays rather than child tables: nothing queries inside them,
    // they are written once and read back whole into the audit package.
    keyPointsJson: text("key_points_json").notNull(),
    citationsJson: text("citations_json").notNull(),
    /** Which model produced it, and which tools it actually ran — the audit trail for how the brief was built. */
    model: text("model").notNull(),
    toolCallsJson: text("tool_calls_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_research_signal").on(t.signalId, t.createdAt)],
);

export const footageSources = sqliteTable("footage_sources", {
  id: text("id").primaryKey(),
  channelUrl: text("channel_url").notNull(),
  game: text("game").notNull(),
  licenseNote: text("license_note").notNull(),
  // Mirrors `sources.enabled` (ARCHITECTURE.md §5.1): a channel is retired
  // by flipping this, never by deleting the row. `renders.footage_segment_id`
  // is a restricting FK, so deleting a source would either fail or destroy
  // the provenance of exports the operator has already reviewed — and §9
  // requires that provenance to stay readable for the life of the export.
  // Both FOOTAGE REFRESH and FOOTAGE SELECT filter on this.
  enabled: integer("enabled").notNull().default(1),
});

export const footageSegments = sqliteTable(
  "footage_segments",
  {
    id: text("id").primaryKey(),
    footageSourceId: text("footage_source_id")
      .notNull()
      .references(() => footageSources.id, { onDelete: "cascade" }),
    sourceVideoId: text("source_video_id").notNull(),
    clipStartS: integer("clip_start_s").notNull(),
    clipEndS: integer("clip_end_s").notNull(),
    motionScore: real("motion_score").notNull(),
    libraryPath: text("library_path").notNull(),
    usedCount: integer("used_count").notNull().default(0),
    lastUsedAt: text("last_used_at"),
    fetchedAt: text("fetched_at").notNull(),
  },
  (t) => [
    check("chk_segment_range", sql`${t.clipEndS} > ${t.clipStartS}`),
    index("idx_segments_source").on(t.footageSourceId, t.usedCount),
  ],
);


export const renders = sqliteTable(
  "renders",
  {
    id: text("id").primaryKey(),
    scriptId: text("script_id")
      .notNull()
      .references(() => scripts.id, { onDelete: "cascade" }),
    footageSegmentId: text("footage_segment_id")
      .notNull()
      .references(() => footageSegments.id),
    ttsDriver: text("tts_driver").notNull(),
    // Actual voice used (not the directive's pool) — feeds the audit
    // package and tomorrow's diversity query (ARCHITECTURE.md §5.6).
    ttsVoice: text("tts_voice").notNull(),
    durationS: real("duration_s"),
    status: text("status", { enum: ["pending", "rendered", "failed"] }).notNull(),
    // AUDIT SUMMARY result (ARCHITECTURE.md §9) — advisory, never blocking.
    auditResult: text("audit_result"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    check("chk_renders_status", sql`${t.status} IN ('pending','rendered','failed')`),
    index("idx_renders_created").on(t.createdAt),
  ],
);

export const exports = sqliteTable(
  "exports",
  {
    id: text("id").primaryKey(),
    renderId: text("render_id")
      .notNull()
      .references(() => renders.id),
    storageKey: text("storage_key").notNull(), // KV key holding the mp4 bytes
    sizeBytes: integer("size_bytes").notNull(),
    suggestedTitle: text("suggested_title").notNull(),
    suggestedDescription: text("suggested_description").notNull(),
    suggestedTagsJson: text("suggested_tags_json").notNull(),
    // Reminder for the operator's manual upload — not enforced anywhere.
    containsSyntheticMedia: integer("contains_synthetic_media").notNull().default(1),
    // script + critic output + footage provenance + TTS settings + audit_result
    auditJson: text("audit_json").notNull(),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(), // created_at + 3 days; KV TTL enforces the actual deletion
    status: text("status", {
      enum: ["ready_for_review", "downloaded", "reviewed", "discarded", "expired"],
    }).notNull(),
  },
  (t) => [
    check(
      "chk_exports_status",
      sql`${t.status} IN ('ready_for_review','downloaded','reviewed','discarded','expired')`,
    ),
  ],
);

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  stage: text("stage").notNull(),
  status: text("status").notNull(),
  tokensIn: integer("tokens_in").default(0),
  tokensOut: integer("tokens_out").default(0),
  errorClass: text("error_class"),
  traceId: text("trace_id").notNull(),
});

/**
 * The operator's picks for a guided run (CONSOLE_SPEC.md's run view, plan
 * v2 §7 steps 1-3): how many videos, which topic each one takes, and which
 * ranked idea they chose for it.
 *
 * This table is what makes those three screens more than a form. RENDER
 * normally chooses its own signal by diversity weighting
 * (scripts/pipeline/render.ts); a queued pick overrides that choice for one
 * invocation, and is claimed atomically so two concurrent renders cannot
 * take the same one. A pick the operator never gets around to is simply
 * still queued — nothing expires it, and nothing renders it twice.
 *
 * `plan_id` groups one submission, so "three videos, chosen together" stays
 * legible as one plan in the console after the fact.
 */
export const runPicks = sqliteTable(
  "run_picks",
  {
    id: text("id").primaryKey(),
    planId: text("plan_id").notNull(),
    /** The operator's ordering within the plan — claimed lowest-first, so the run builds the videos in the order they were chosen. */
    position: integer("position").notNull(),
    /** One of src/server/console/ideas.ts's TOPICS. Stored as text, not an enum check: the topic list is a product decision that will move, and a stale CHECK constraint would fail a write rather than a review. */
    topic: text("topic").notNull(),
    signalId: text("signal_id")
      .notNull()
      .references(() => signals.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["queued", "claimed", "cancelled"] }).notNull(),
    /** The `runs.trace_id` that claimed this pick — the link back to the run view that is watching it. */
    claimedTraceId: text("claimed_trace_id"),
    claimedAt: text("claimed_at"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    check("chk_run_picks_status", sql`${t.status} IN ('queued','claimed','cancelled')`),
    index("idx_run_picks_claimable").on(t.status, t.position),
    index("idx_run_picks_plan").on(t.planId),
  ],
);

export const auditLog = sqliteTable("audit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  at: text("at").notNull(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  subject: text("subject").notNull(),
  detailJson: text("detail_json").notNull(),
});

export const directives = sqliteTable(
  "directives",
  {
    version: integer("version").primaryKey({ autoIncrement: true }),
    createdAt: text("created_at").notNull(),
    rawText: text("raw_text").notNull(),
    // focus_games, exclude_topics, min_originality_score, max_uploads_per_day,
    // tone, editorial_note, voice_pool, tts_rate_range, preferred_source_ids,
    // diversity_mode — full schema in CONSOLE_SPEC.md §3.
    compiledJson: text("compiled_json").notNull(),
    status: text("status", { enum: ["draft", "active", "superseded", "reverted"] }).notNull(),
    parentVersion: integer("parent_version"),
  },
  (t) => [
    uniqueIndex("uq_directive_active").on(t.status).where(sql`${t.status} = 'active'`),
    check("chk_directives_status", sql`${t.status} IN ('draft','active','superseded','reverted')`),
  ],
);

export const credentials = sqliteTable("credentials", {
  credentialId: text("credential_id").primaryKey(),
  publicKey: blob("public_key", { mode: "buffer" }).notNull(),
  counter: integer("counter").notNull().default(0),
  transports: text("transports"),
  createdAt: text("created_at").notNull(),
  lastUsedAt: text("last_used_at"),
  label: text("label").notNull(),
});

// Step-up reauth (CONSOLE_SPEC.md §1/§2): a fresh WebAuthn assertion within
// the last 5 minutes gates key rotation and the killswitch. Consumed via a
// single atomic UPDATE...RETURNING (same pattern as
// db/footage-select.ts's claimNextFootageSegment) rather than a KV
// get-then-delete, which can't be made atomic at this binding level.
export const reauthNonces = sqliteTable("reauth_nonces", {
  nonce: text("nonce").primaryKey(),
  sessionId: text("session_id").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  consumed: integer("consumed").notNull().default(0),
});

// Pending WebAuthn ceremonies (CONSOLE_SPEC.md §1). The Worker is
// stateless between the "generate options" and "verify response" calls of
// a single ceremony, so the expected challenge has to live somewhere the
// server — not the client — looks it up from; `id` is the only thing
// handed to the browser, purely as a lookup key, never as the challenge
// value itself. Consumed atomically, same UPDATE...RETURNING pattern as
// reauth_nonces/footage_segments.
export const webauthnChallenges = sqliteTable(
  "webauthn_challenges",
  {
    id: text("id").primaryKey(),
    challenge: text("challenge").notNull(),
    purpose: text("purpose", { enum: ["register", "authenticate", "reauth"] }).notNull(),
    sessionId: text("session_id"), // set for 'reauth' — ties the ceremony to the session it steps up
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    consumed: integer("consumed").notNull().default(0),
  },
  (t) => [check("chk_webauthn_challenges_purpose", sql`${t.purpose} IN ('register','authenticate','reauth')`)],
);

// Recovery codes (CONSOLE_SPEC.md §1): 8 shown once at first enrollment,
// hashed here so a DB leak alone can't be used to log in. PBKDF2-SHA256 via
// native crypto.subtle, not Argon2id as CONSOLE_SPEC.md literally says —
// Argon2id has no Web Crypto implementation and every practical option
// needs a wasm dependency disproportionate to 8 one-time codes; see
// docs/DECISIONS.md. A redemption endpoint is out of scope here (not in
// ARCHITECTURE.md §6's route table) — generation + storage only.
export const recoveryCodes = sqliteTable("recovery_codes", {
  id: text("id").primaryKey(),
  hash: text("hash").notNull(),
  salt: text("salt").notNull(),
  used: integer("used").notNull().default(0),
  createdAt: text("created_at").notNull(),
});

// Chat-agent console (AGENT_PLAYBOOK.md Phase 8 follow-on) — one operator's
// past conversations with the Groq tool-calling agent that drives the same
// service layer as the REST console routes (src/server/console/**).
export const chatSessions = sqliteTable("chat_sessions", {
  id: text("id").primaryKey(),
  title: text("title").notNull(), // derived from the first user message
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const chatMessages = sqliteTable(
  "chat_messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "assistant", "tool"] }).notNull(),
    content: text("content").notNull(),
    // Set only when role = 'tool' — which console action ran and with what
    // args/result, so the transcript shows agent actions as first-class,
    // not just prose (CONSOLE_SPEC.md threat model: nothing here hides an
    // action from the reviewer).
    toolName: text("tool_name"),
    toolArgsJson: text("tool_args_json"),
    toolResultJson: text("tool_result_json"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("idx_chat_messages_session").on(t.sessionId, t.createdAt),
    check("chk_chat_messages_role", sql`${t.role} IN ('user','assistant','tool')`),
  ],
);

// MCP access tokens (docs/DECISIONS.md, MCP-as-runtime-integration ADR):
// lets an external MCP client (Claude Desktop, Claude Code) authenticate to
// POST /console/mcp without a WebAuthn session. High-entropy random tokens,
// not human passwords, so a fast SHA-256 hash (src/server/mcp/tokens.ts) is
// the right primitive here — same reasoning src/lib/vault.ts's fingerprintOf
// already uses, not Argon2id/PBKDF2. Only ever grants the same AGENT_TOOLS
// allowlist the console chat/voice agent already has — no key rotation, no
// killswitch tool exists for a token to call, by construction.
export const mcpTokens = sqliteTable("mcp_tokens", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  hash: text("hash").notNull(),
  createdAt: text("created_at").notNull(),
  lastUsedAt: text("last_used_at"),
  revokedAt: text("revoked_at"),
});
