CREATE TABLE `fetch_buckets` (
	`bucket` text PRIMARY KEY NOT NULL,
	`consecutive_throttles` integer DEFAULT 0 NOT NULL,
	`cooldown_until` integer DEFAULT 0 NOT NULL,
	`next_allowed_at` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `backfill_cursor` integer DEFAULT 0 NOT NULL;