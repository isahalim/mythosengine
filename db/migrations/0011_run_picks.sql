CREATE TABLE `run_picks` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`position` integer NOT NULL,
	`topic` text NOT NULL,
	`signal_id` text NOT NULL,
	`status` text NOT NULL,
	`claimed_trace_id` text,
	`claimed_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`signal_id`) REFERENCES `signals`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_run_picks_status" CHECK("run_picks"."status" IN ('queued','claimed','cancelled'))
);
--> statement-breakpoint
CREATE INDEX `idx_run_picks_claimable` ON `run_picks` (`status`,`position`);--> statement-breakpoint
CREATE INDEX `idx_run_picks_plan` ON `run_picks` (`plan_id`);