import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import initSqlJs from 'sql.js';
import { drizzle } from 'drizzle-orm/sql-js';

import * as schema from '../db/schema.js';

let sqlJsPromise: Promise<Awaited<ReturnType<typeof initSqlJs>>> | undefined;

async function loadSqlJs() {
  if (!sqlJsPromise) {
    sqlJsPromise = initSqlJs({
      locateFile(fileName: string) {
        return resolve(dirname(fileURLToPath(import.meta.url)), '../../node_modules/sql.js/dist', fileName);
      },
    });
  }

  return sqlJsPromise;
}

export async function createTestDatabase() {
  const SQL = await loadSqlJs();
  const sqlite = new SQL.Database();
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE articles (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL UNIQUE,
      site_url TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      content TEXT,
      published_at INTEGER,
      summary TEXT,
      hatena_summary TEXT,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE hatena_bookmarks (
      id TEXT PRIMARY KEY,
      article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
      user TEXT NOT NULL,
      comment TEXT,
      created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE subscriptions (
      id TEXT PRIMARY KEY,
      site_url TEXT NOT NULL UNIQUE,
      title TEXT,
      added_at INTEGER NOT NULL DEFAULT 0
    );
  `);

  const db = drizzle(sqlite, { schema });

  return {
    db,
    sqlite,
  };
}
