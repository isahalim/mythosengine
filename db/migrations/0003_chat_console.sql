CREATE TABLE `chat_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`tool_name` text,
	`tool_args_json` text,
	`tool_result_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `chat_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_chat_messages_role" CHECK("chat_messages"."role" IN ('user','assistant','tool'))
);
--> statement-breakpoint
CREATE INDEX `idx_chat_messages_session` ON `chat_messages` (`session_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `chat_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
