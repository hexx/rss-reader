import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { InferSelectModel } from 'drizzle-orm';

const createdAtDefault = sql<number>`(cast((julianday('now') - 2440587.5) * 86400000 as integer))`;

export const articles = sqliteTable('articles', {
  id: text('id').primaryKey(),
  url: text('url').notNull().unique(),
  siteUrl: text('site_url').notNull().default(''),
  title: text('title').notNull(),
  content: text('content'),
  publishedAt: integer('published_at', { mode: 'timestamp_ms' }),
  summary: text('summary'),
  hatenaSummary: text('hatena_summary'),
  isRead: integer('is_read', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(createdAtDefault),
});

/**
 * はてなブックマーク。
 *
 * `(article_id, user)` に UNIQUE を張ることで、「同じユーザーが同じ記事に
 * 複数回ブックマークしても 1 行しか存在しない」ことを DB レベルで保証する。
 * これにより `INSERT ... ON CONFLICT (article_id, user) DO NOTHING` が
 * 冪等に動作し、再取得で重複行が増殖しない。
 */
export const hatenaBookmarks = sqliteTable(
  'hatena_bookmarks',
  {
    id: text('id').primaryKey(),
    articleId: text('article_id')
      .notNull()
      .references(() => articles.id, { onDelete: 'cascade' }),
    user: text('user').notNull(),
    comment: text('comment'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(createdAtDefault),
  },
  (table) => ({
    articleUserUnique: uniqueIndex('hatena_bookmarks_article_id_user_unique').on(
      table.articleId,
      table.user,
    ),
  }),
);

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
