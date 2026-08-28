CREATE TABLE `exports` (
	`id` text PRIMARY KEY NOT NULL,
	`render_id` text NOT NULL,
	`storage_key` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`suggested_title` text NOT NULL,
	`suggested_description` text NOT NULL,
	`suggested_tags_json` text NOT NULL,
	`contains_synthetic_media` integer DEFAULT 1 NOT NULL,
	`audit_json` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`status` text NOT NULL,
	FOREIGN KEY (`render_id`) REFERENCES `renders`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_exports_status" CHECK("exports"."status" IN ('ready_for_review','downloaded','reviewed','discarded','expired'))
);
--> statement-breakpoint
DROP TABLE `uploads`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_signals` (
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
	CONSTRAINT "chk_signals_state" CHECK("__new_signals"."state" IN ('observed','scored','scripted','critiqued','exported','rejected','failed'))
);
--> statement-breakpoint
INSERT INTO `__new_signals`("id", "source_id", "canonical_url", "title", "observed_at", "engagement_score", "simhash", "state", "attempts") SELECT "id", "source_id", "canonical_url", "title", "observed_at", "engagement_score", "simhash", "state", "attempts" FROM `signals`;--> statement-breakpoint
DROP TABLE `signals`;--> statement-breakpoint
ALTER TABLE `__new_signals` RENAME TO `signals`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_signals_source_url` ON `signals` (`source_id`,`canonical_url`);--> statement-breakpoint
CREATE INDEX `idx_signals_state` ON `signals` (`state`,`observed_at`);--> statement-breakpoint
ALTER TABLE `renders` ADD `tts_voice` text NOT NULL;--> statement-breakpoint
ALTER TABLE `renders` ADD `audit_result` text;--> statement-breakpoint
ALTER TABLE `renders` ADD `created_at` text NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_renders_created` ON `renders` (`created_at`);--> statement-breakpoint
ALTER TABLE `renders` DROP COLUMN `gate_result`;--> statement-breakpoint
ALTER TABLE `scripts` ADD `created_at` text NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_scripts_created` ON `scripts` (`created_at`);