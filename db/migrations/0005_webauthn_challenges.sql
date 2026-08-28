CREATE TABLE `webauthn_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`challenge` text NOT NULL,
	`purpose` text NOT NULL,
	`session_id` text,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`consumed` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "chk_webauthn_challenges_purpose" CHECK("webauthn_challenges"."purpose" IN ('register','authenticate','reauth'))
);
