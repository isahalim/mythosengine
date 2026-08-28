CREATE TABLE `mcp_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`hash` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text,
	`revoked_at` text
);
