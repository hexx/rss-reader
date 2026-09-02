import { resolve } from 'node:path';

import initSqlJs from 'sql.js';
import { drizzle } from 'drizzle-orm/sql-js';

import { createdAtDefaultExpression } from '../db/schema.js';
import * as schema from '../db/schema.js';

let sqlJsPromise: Promise<Awaited<ReturnType<typeof initSqlJs>>> | undefined;

function loadSqlJs() {
  if (!sqlJsPromise) {
    sqlJsPromise = initSqlJs({
      locateFile(fileName: string) {
        return resolve(import.meta.dirname, '../../node_modules/sql.js/dist', fileName);
      },
    }).catch((error: unknown) => {
      // 初期化失敗時はキャッシュを破棄し、次回呼び出しで再試行できるようにする
      sqlJsPromise = undefined;
      throw error;
    });
  }

  return sqlJsPromise;
}

export async function createTestDatabase(options: { initializeSchema?: boolean } = {}) {
  const { initializeSchema = true } = options;
  const SQL = await loadSqlJs();
  const sqlite = new SQL.Database();
  if (initializeSchema) {
    sqlite.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE articles (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL UNIQUE,
        site_url TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL,
        content TEXT,
        published_at INTEGER,
        content_backfill_at INTEGER,
        summary TEXT,
        hatena_summary TEXT,
        is_read INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT ${createdAtDefaultExpression}
      );
      CREATE TABLE hatena_bookmarks (
        id TEXT PRIMARY KEY,
        article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
        user TEXT NOT NULL,
        comment TEXT,
        created_at INTEGER NOT NULL DEFAULT ${createdAtDefaultExpression}
      );
      CREATE UNIQUE INDEX hatena_bookmarks_article_id_user_unique
        ON hatena_bookmarks (article_id, user);
      CREATE TABLE subscriptions (
        id TEXT PRIMARY KEY,
        site_url TEXT NOT NULL UNIQUE,
        title TEXT,
        backfill_cursor INTEGER NOT NULL DEFAULT 0,
        added_at INTEGER NOT NULL DEFAULT ${createdAtDefaultExpression}
      );
      CREATE TABLE fetch_buckets (
        bucket TEXT PRIMARY KEY,
        consecutive_throttles INTEGER NOT NULL DEFAULT 0,
        cooldown_until INTEGER NOT NULL DEFAULT 0,
        next_allowed_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX articles_site_url_is_read_idx ON articles (site_url, is_read);
      CREATE INDEX articles_sort_idx ON articles (coalesce("published_at", "created_at"));
    `);
  }

  const db = drizzle(sqlite, { schema });

  return {
    db,
    sqlite,
  };
}
