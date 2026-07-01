import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { InferSelectModel } from 'drizzle-orm';

const createdAtDefault = sql<number>`(cast((julianday('now') - 2440587.5) * 86400000 as integer))`;

export const articles = sqliteTable('articles', {
  content: text('content'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(createdAtDefault),
  hatenaSummary: text('hatena_summary'),
  id: text('id').primaryKey(),
  isRead: integer('is_read', { mode: 'boolean' }).notNull().default(false),
  publishedAt: integer('published_at', { mode: 'timestamp_ms' }),
  siteUrl: text('site_url').notNull().default(''),
  summary: text('summary'),
  title: text('title').notNull(),
  url: text('url').notNull().unique(),
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
    articleId: text('article_id')
      .notNull()
      .references(() => articles.id, { onDelete: 'cascade' }),
    comment: text('comment'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(createdAtDefault),
    id: text('id').primaryKey(),
    user: text('user').notNull(),
  },
  (table) => ({
    articleUserUnique: uniqueIndex('hatena_bookmarks_article_id_user_unique').on(
      table.articleId,
      table.user,
    ),
  }),
);

export const subscriptions = sqliteTable('subscriptions', {
  addedAt: integer('added_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(createdAtDefault),
  id: text('id').primaryKey(),
  siteUrl: text('site_url').notNull().unique(),
  title: text('title'),
});

export type Article = InferSelectModel<typeof articles>;
export type HatenaBookmark = InferSelectModel<typeof hatenaBookmarks>;
export type Subscription = InferSelectModel<typeof subscriptions>;
