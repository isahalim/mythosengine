CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`subject` text NOT NULL,
	`detail_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `credentials` (
	`credential_id` text PRIMARY KEY NOT NULL,
	`public_key` blob NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	`transports` text,
	`created_at` text NOT NULL,
	`last_used_at` text,
	`label` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `directives` (
	`version` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` text NOT NULL,
	`raw_text` text NOT NULL,
	`compiled_json` text NOT NULL,
	`status` text NOT NULL,
	`parent_version` integer,
	CONSTRAINT "chk_directives_status" CHECK("directives"."status" IN ('draft','active','superseded','reverted'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_directive_active` ON `directives` (`status`) WHERE "directives"."status" = 'active';--> statement-breakpoint
CREATE TABLE `footage_segments` (
	`id` text PRIMARY KEY NOT NULL,
	`footage_source_id` text NOT NULL,
	`source_video_id` text NOT NULL,
	`clip_start_s` integer NOT NULL,
	`clip_end_s` integer NOT NULL,
	`motion_score` real NOT NULL,
	`library_path` text NOT NULL,
	`used_count` integer DEFAULT 0 NOT NULL,
	`last_used_at` text,
	`fetched_at` text NOT NULL,
	FOREIGN KEY (`footage_source_id`) REFERENCES `footage_sources`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_segment_range" CHECK("footage_segments"."clip_end_s" > "footage_segments"."clip_start_s")
);
--> statement-breakpoint
CREATE INDEX `idx_segments_source` ON `footage_segments` (`footage_source_id`,`used_count`);--> statement-breakpoint
CREATE TABLE `footage_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_url` text NOT NULL,
	`game` text NOT NULL,
	`license_note` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `renders` (
	`id` text PRIMARY KEY NOT NULL,
	`script_id` text NOT NULL,
	`footage_segment_id` text NOT NULL,
	`tts_driver` text NOT NULL,
	`duration_s` real,
	`status` text NOT NULL,
	`gate_result` text,
	FOREIGN KEY (`script_id`) REFERENCES `scripts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`footage_segment_id`) REFERENCES `footage_segments`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_renders_status" CHECK("renders"."status" IN ('pending','rendered','failed'))
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`stage` text NOT NULL,
	`status` text NOT NULL,
	`tokens_in` integer DEFAULT 0,
	`tokens_out` integer DEFAULT 0,
	`error_class` text,
	`trace_id` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `scripts` (
	`id` text PRIMARY KEY NOT NULL,
	`signal_id` text NOT NULL,
	`hook` text NOT NULL,
	`body` text NOT NULL,
	`debate_question` text NOT NULL,
	`word_count` integer NOT NULL,
	`originality_score` real,
	`status` text NOT NULL,
	FOREIGN KEY (`signal_id`) REFERENCES `signals`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_scripts_status" CHECK("scripts"."status" IN ('draft','approved','rejected'))
);
--> statement-breakpoint
CREATE TABLE `signals` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`canonical_url` text NOT NULL,
	`title` text NOT NULL,
	`observed_at` text NOT NULL,
	`engagement_score` real NOT NULL,
	`simhash` text NOT NULL,
	`state` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_signals_state" CHECK("signals"."state" IN ('observed','scored','scripted','critiqued','gated','uploaded','rejected','failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_signals_source_url` ON `signals` (`source_id`,`canonical_url`);--> statement-breakpoint
CREATE INDEX `idx_signals_state` ON `signals` (`state`,`observed_at`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`url` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`last_seen_at` text,
	CONSTRAINT "chk_sources_kind" CHECK("sources"."kind" IN ('reddit','rss','x','youtube_community'))
);
--> statement-breakpoint
CREATE TABLE `uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`render_id` text NOT NULL,
	`youtube_video_id` text,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`tags_json` text NOT NULL,
	`contains_synthetic_media` integer DEFAULT 1 NOT NULL,
	`uploaded_at` text,
	`status` text NOT NULL,
	FOREIGN KEY (`render_id`) REFERENCES `renders`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_uploads_status" CHECK("uploads"."status" IN ('pending_approval','approved','published','failed'))
);
