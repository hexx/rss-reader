CREATE TABLE `articles` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`site_url` text DEFAULT '' NOT NULL,
	`title` text NOT NULL,
	`content` text,
	`summary` text,
	`hatena_summary` text,
	`is_read` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `articles_url_unique` ON `articles` (`url`);--> statement-breakpoint
CREATE TABLE `hatena_bookmarks` (
	`id` text PRIMARY KEY NOT NULL,
	`article_id` text NOT NULL,
	`user` text NOT NULL,
	`comment` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`site_url` text NOT NULL,
	`added_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscriptions_site_url_unique` ON `subscriptions` (`site_url`);