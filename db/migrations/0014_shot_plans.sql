-- PLAN, made visible.
--
-- Operator direction, 2026-09-01: "make the agents deployed section have a
-- robust instruction/process for the agents to source multiple footage ...
-- make the agents make a proper plan so they can execute it properly".
--
-- Stage 5's contract (src/server/console/runs.ts) is that it reports only
-- what the pipeline has actually recorded — no interpolated percentages, no
-- estimated finish times. A plan the operator can watch being executed obeys
-- that contract and satisfies the request at the same time: every row here
-- is written by the stage that did the thing, and `status` moves only when
-- something really happened.
CREATE TABLE `shot_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`script_id` text NOT NULL,
	`trace_id` text NOT NULL,
	`position` integer NOT NULL,
	-- Null for the opening image over the hook.
	`beat_index` integer,
	-- One sentence, written by PLAN, for the human reviewer: what this image
	-- is doing for this beat. Not a description of the picture.
	`intent` text NOT NULL,
	-- What was typed into the search box. Recorded because "why is there a
	-- chessboard in a video about determinism" is a question about the
	-- selection, and it is not answerable from the clip.
	`query` text NOT NULL,
	`source` text NOT NULL,
	`status` text NOT NULL,
	-- Set once the clip exists and has a provenance row. Null before that,
	-- and null forever on a shot that failed.
	`footage_segment_id` text,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`script_id`) REFERENCES `scripts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_shot_source" CHECK(`source` IN ('youtube','pexels')),
	CONSTRAINT "chk_shot_status" CHECK(`status` IN ('planned','searching','downloading','clipped','composited','failed')),
	CONSTRAINT "chk_shot_position" CHECK(`position` >= 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_shot_position` ON `shot_plans` (`script_id`,`position`);--> statement-breakpoint
CREATE INDEX `idx_shot_trace` ON `shot_plans` (`trace_id`);
