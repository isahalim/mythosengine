-- The chat route (operator direction, 2026-09-04): an operator who arrives
-- with an idea in their head types it, and the pipeline builds that video
-- instead of one drawn from WATCH's corpus.
--
-- Three changes, and the first is the load-bearing one.
--
-- 1. `sources.kind` gains 'operator'. `signals.source_id` is a NOT NULL
--    foreign key, and the whole design of the chat route rests on its idea
--    becoming a REAL `signals` row in state 'scored' — that is what lets
--    SCRIPT's foreign key, `claimNextRunPick`'s eligibility subquery and
--    `queuePlan`'s validation all work with no change whatsoever. A synthetic
--    signal needs a source, and the existing CHECK refused one.
--
--    SQLite cannot ALTER a CHECK constraint, so the table is rebuilt in the
--    12-step order the SQLite docs prescribe. Every column, index and default
--    is reproduced exactly; only the CHECK is wider.
--
-- 2. `briefs` — one row per thing the operator asked for.
-- 3. `brief_attachments` — the files they attached, whose bytes are in R2.

PRAGMA foreign_keys=OFF;--> statement-breakpoint

CREATE TABLE `__new_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`url` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`last_seen_at` text,
	`etag` text,
	`last_modified` text,
	CONSTRAINT "chk_sources_kind" CHECK("__new_sources"."kind" IN ('reddit','rss','x','youtube_community','operator'))
);--> statement-breakpoint

INSERT INTO `__new_sources` (`id`, `kind`, `url`, `enabled`, `last_seen_at`, `etag`, `last_modified`)
	SELECT `id`, `kind`, `url`, `enabled`, `last_seen_at`, `etag`, `last_modified` FROM `sources`;--> statement-breakpoint

DROP TABLE `sources`;--> statement-breakpoint
ALTER TABLE `__new_sources` RENAME TO `sources`;--> statement-breakpoint

PRAGMA foreign_keys=ON;--> statement-breakpoint

CREATE TABLE `briefs` (
	`id` text PRIMARY KEY NOT NULL,
	`prompt` text NOT NULL,
	`status` text NOT NULL,
	`trace_id` text,
	`plan_id` text,
	`signal_id` text,
	`digest_json` text,
	`failure_reason` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "chk_briefs_status" CHECK("briefs"."status" IN ('queued','digesting','running','succeeded','failed'))
);--> statement-breakpoint

CREATE INDEX `idx_briefs_created` ON `briefs` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_briefs_status` ON `briefs` (`status`);--> statement-breakpoint

CREATE TABLE `brief_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`brief_id` text NOT NULL,
	`position` integer NOT NULL,
	`filename` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`storage_key` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`brief_id`) REFERENCES `briefs`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint

CREATE INDEX `idx_brief_attachments_brief` ON `brief_attachments` (`brief_id`,`position`);
