import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { InferSelectModel } from 'drizzle-orm';

/** created_at / added_at の既定値（epoch ms）。テスト用スキーマ (test-utils/sqljs-db.ts) と共有する。 */
export const createdAtDefaultExpression = `(cast((julianday('now') - 2440587.5) * 86400000 as integer))`;

// sql テンプレートへの文字列挿入はパラメータ化されるため、式を raw として埋め込む。
const createdAtDefault = sql<number>`${sql.raw(createdAtDefaultExpression)}`;

export const articles = sqliteTable(
  'articles',
  {
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
  },
  (table) => ({
    // 記事一覧 API は site_url と is_read を組み合わせてフィルタするため、
    // 複合インデックスを張る（site_url 単独の検索はプレフィックスでカバーされる）。
    // 並び順の coalesce 式は式インデックスでカバーする。
    // 注意: worker.ts の fetchArticles の ORDER BY と同一の式を保つこと
    // （ずれると SQLite がこのインデックスを使えなくなる）。
    siteUrlIsReadIndex: index('articles_site_url_is_read_idx').on(table.siteUrl, table.isRead),
    sortIndex: index('articles_sort_idx').on(sql`coalesce(${table.publishedAt}, ${table.createdAt})`),
  }),
);

/**
 * はてなブックマーク。
 *
 * `(article_id, user)` に UNIQUE を張ることで、「同じユーザーが同じ記事に
 * 複数回ブックマークしても 1 行しか存在しない」ことを DB レベルで保証する。
 * これにより `INSERT ... ON CONFLICT (article_id, user) DO UPDATE` が
 * 冪等に動作し、再取得で重複行が増殖しない（競合時は createdAt・comment を最新化する）。
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
