CREATE TABLE `recovery_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`hash` text NOT NULL,
	`salt` text NOT NULL,
	`used` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
