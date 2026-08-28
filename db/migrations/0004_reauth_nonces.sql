CREATE TABLE `reauth_nonces` (
	`nonce` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`consumed` integer DEFAULT 0 NOT NULL
);
