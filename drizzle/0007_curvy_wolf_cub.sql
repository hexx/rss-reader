ALTER TABLE `articles` ADD `content_backfill_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `articles` ADD `content_backfill_gave_up_at` integer;