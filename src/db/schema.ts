import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { InferSelectModel } from 'drizzle-orm';

const createdAtDefault = sql<number>`(cast((julianday('now') - 2440587.5) * 86400000 as integer))`;

// Migration steps:
// DATABASE_URL=./sqlite.db npx drizzle-kit generate
// DATABASE_URL=./sqlite.db npx drizzle-kit push
export const articles = sqliteTable('articles', {
  id: text('id').primaryKey(),
  url: text('url').notNull().unique(),
  siteUrl: text('site_url').notNull().default(''),
  title: text('title').notNull(),
  content: text('content'),
  summary: text('summary'),
  hatenaSummary: text('hatena_summary'),
  isRead: integer('is_read', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(createdAtDefault),
});

export const hatenaBookmarks = sqliteTable('hatena_bookmarks', {
  id: text('id').primaryKey(),
  articleId: text('article_id')
    .notNull()
    .references(() => articles.id, { onDelete: 'cascade' }),
  user: text('user').notNull(),
  comment: text('comment'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(createdAtDefault),
});

export const subscriptions = sqliteTable('subscriptions', {
  id: text('id').primaryKey(),
  siteUrl: text('site_url').notNull().unique(),
  title: text('title'),
  addedAt: integer('added_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(createdAtDefault),
});

export type Article = InferSelectModel<typeof articles>;
export type HatenaBookmark = InferSelectModel<typeof hatenaBookmarks>;
export type Subscription = InferSelectModel<typeof subscriptions>;
