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
