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
--    SQLite cannot ALTER a CHECK constraint, so the table is rebuilt. Every
--    column, index and default is reproduced exactly; only the CHECK is
--    wider — and the rebuild is written to survive D1, which is a longer
--    story told where it happens, below.
--
-- 2. `briefs` — one row per thing the operator asked for.
-- 3. `brief_attachments` — the files they attached, whose bytes are in R2.

-- SQLite cannot ALTER a CHECK constraint, so `sources` is rebuilt. The
-- 12-step recipe in the SQLite docs opens with `PRAGMA foreign_keys=OFF`,
-- and on D1 that line is a lie: wrangler applies a migration inside one
-- transaction, and `PRAGMA foreign_keys` is documented as a no-op within a
-- transaction. So foreign keys stayed ON, and `DROP TABLE sources` did what
-- an enforced drop of a *parent* table does — an implicit `DELETE FROM
-- sources`, which fires `signals.source_id`'s ON DELETE CASCADE and takes
-- signals → scripts → renders with it, until `exports.render_id` (ON DELETE
-- no action) refuses and the whole migration rolls back. That is the
-- SQLITE_CONSTRAINT_FOREIGNKEY the 2026-09-05 deploy died on, and the refusal
-- is the only reason 1,234 signals and 14 exports still exist.
--
-- `PRAGMA defer_foreign_keys` is D1's supported replacement, but on its own
-- it does not save this: deferral postpones the *check*, and a cascade is an
-- *action*. Verified locally against a copy of this foreign-key graph — with
-- deferral alone the drop still deletes signals, scripts and renders, and
-- then fails at COMMIT on the dangling exports.
--
-- So the drop is made to find nothing to cascade to. The children are
-- repointed to ids no source row has, which is a foreign-key violation that
-- deferral genuinely does cover; the emptied-of-matches drop cascades to zero
-- rows; the new table takes the name, which is what `signals`' FK clause
-- resolves by; and the children are repointed back before COMMIT, so the
-- deferred-violation counter returns to zero. `signals` is the only table
-- with a foreign key to `sources`.
--
-- The new CHECK is written unqualified. Drizzle emits `CHECK("__new_sources".
-- "kind" ...)`, and that qualifier has to survive the rename to `sources`;
-- D1's SQLite rewrites it (migration 0002 did exactly this and the live
-- schema reads `"signals"."state"`), but SQLite 3.54 refuses the rename
-- outright. Unqualified is correct on both.

PRAGMA defer_foreign_keys=on;--> statement-breakpoint

CREATE TABLE `__new_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`url` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`last_seen_at` text,
	`etag` text,
	`last_modified` text,
	CONSTRAINT "chk_sources_kind" CHECK(`kind` IN ('reddit','rss','x','youtube_community','operator'))
);--> statement-breakpoint

INSERT INTO `__new_sources` (`id`, `kind`, `url`, `enabled`, `last_seen_at`, `etag`, `last_modified`)
	SELECT `id`, `kind`, `url`, `enabled`, `last_seen_at`, `etag`, `last_modified` FROM `sources`;--> statement-breakpoint

-- Verified 2026-09-05 against the live database: no `signals.source_id`
-- begins with this prefix, and the strip below is guarded by the same LIKE,
-- so a row that somehow did is left alone rather than truncated.
UPDATE `signals` SET `source_id` = 'mig0017:' || `source_id`;--> statement-breakpoint

DROP TABLE `sources`;--> statement-breakpoint
ALTER TABLE `__new_sources` RENAME TO `sources`;--> statement-breakpoint

UPDATE `signals` SET `source_id` = substr(`source_id`, 9) WHERE `source_id` LIKE 'mig0017:%';--> statement-breakpoint

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
