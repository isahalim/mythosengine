CREATE TABLE `research_briefs` (
	`id` text PRIMARY KEY NOT NULL,
	`signal_id` text NOT NULL,
	`summary` text NOT NULL,
	`key_points_json` text NOT NULL,
	`citations_json` text NOT NULL,
	`model` text NOT NULL,
	`tool_calls_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`signal_id`) REFERENCES `signals`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_research_signal` ON `research_briefs` (`signal_id`,`created_at`);