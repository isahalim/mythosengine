ALTER TABLE `scripts` ADD `trace_id` text;--> statement-breakpoint
CREATE INDEX `idx_scripts_trace` ON `scripts` (`trace_id`);
--> statement-breakpoint
-- Plan v2 §7 step 4 (the guided run's waiting screen). `runs` rows already
-- share a `trace_id` per pipeline invocation, but nothing produced by that
-- invocation pointed back at it, so the console could show a run's *stages*
-- and never the videos those stages were building. This column is that
-- link. It sits on `scripts` because the waiting screen needs it seconds
-- into a run, and `renders` is not written until minutes later.
