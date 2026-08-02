CREATE INDEX `articles_site_url_is_read_idx` ON `articles` (`site_url`,`is_read`);--> statement-breakpoint
CREATE INDEX `articles_sort_idx` ON `articles` (coalesce("published_at", "created_at"));