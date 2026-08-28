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
    // Drives "today's diversity" queries (ARCHITECTURE.md §5.3) — which
    // sources/games/voices today's earlier renders already used.
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    check("chk_scripts_status", sql`${t.status} IN ('draft','approved','rejected')`),
    index("idx_scripts_created").on(t.createdAt),
  ],
);

export const footageSources = sqliteTable("footage_sources", {
  id: text("id").primaryKey(),
  channelUrl: text("channel_url").notNull(),
  game: text("game").notNull(),
  licenseNote: text("license_note").notNull(),
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
