-- Stock footage: a second kind of library source, and a render made of more
-- than one clip.
--
-- Operator direction, 2026-09-01: "include footage from pexels (multiple) and
-- stitch them together as relevant to the script ... instead of only using
-- gta v footage". CLAUDE.md's constraint is that a render never uses footage
-- outside the maintained, provenance-tracked library — a constraint on
-- provenance, not on genre. So stock clips enter the same two tables the
-- gameplay clips live in, with the same rotation and the same audit trail,
-- rather than reaching the encoder down a side path with no rows behind it.

ALTER TABLE `footage_sources` ADD `kind` text DEFAULT 'gameplay' NOT NULL CHECK (`kind` IN ('gameplay','stock'));--> statement-breakpoint

-- Stock attribution. Null on a gameplay row, where the channel URL on the
-- source is the whole attribution; required on a stock row, because the
-- Pexels licence is per clip and per photographer and an export that names
-- neither cannot be checked by the reviewer §9 exists for.
ALTER TABLE `footage_segments` ADD `provider` text;--> statement-breakpoint
ALTER TABLE `footage_segments` ADD `provider_clip_id` text;--> statement-breakpoint
ALTER TABLE `footage_segments` ADD `photographer` text;--> statement-breakpoint
ALTER TABLE `footage_segments` ADD `page_url` text;--> statement-breakpoint
-- The keyword that retrieved this clip. Recorded because "why is there a
-- shot of a chessboard in a video about determinism" is a question about the
-- selection, not about the clip, and it is not answerable from either.
ALTER TABLE `footage_segments` ADD `search_query` text;--> statement-breakpoint

-- One row per clip in a render, in the order they appear.
--
-- `renders.footage_segment_id` still points at part 0, so every existing
-- reader — the console's export list, the audit package, the diversity
-- queries — keeps working unchanged and a single-clip render is just a
-- montage of one.
CREATE TABLE `render_footage_parts` (
	`id` text PRIMARY KEY NOT NULL,
	`render_id` text NOT NULL,
	`position` integer NOT NULL,
	`footage_segment_id` text NOT NULL,
	`start_ms` integer NOT NULL,
	`end_ms` integer NOT NULL,
	FOREIGN KEY (`render_id`) REFERENCES `renders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`footage_segment_id`) REFERENCES `footage_segments`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_part_range" CHECK(`end_ms` > `start_ms`),
	CONSTRAINT "chk_part_position" CHECK(`position` >= 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_render_part_position` ON `render_footage_parts` (`render_id`,`position`);--> statement-breakpoint
CREATE INDEX `idx_part_segment` ON `render_footage_parts` (`footage_segment_id`);
