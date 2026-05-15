import 'dotenv/config';

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { D1Database } from '@cloudflare/workers-types';
import Database from 'better-sqlite3';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import * as schema from './schema.js';
import type { RuntimeEnv } from '../env.js';

export function getDatabasePath(env: RuntimeEnv = process.env): string {
  return env.DATABASE_URL?.trim() || './sqlite.db';
}

export function createSqliteDatabase(env: RuntimeEnv = process.env) {
  const databasePath = getDatabasePath(env);
  mkdirSync(dirname(databasePath), { recursive: true });

  const sqliteDatabase = new Database(databasePath);
  sqliteDatabase.pragma('foreign_keys = ON');

  return sqliteDatabase;
}

export const databasePath = getDatabasePath();
export const sqlite = createSqliteDatabase();
export const db = drizzle(sqlite, { schema }) as DatabaseClient;

type DatabaseEnv = RuntimeEnv & {
  DB?: D1Database;
};

export interface DatabaseClient {
  delete: (...args: unknown[]) => any;
  insert: (...args: unknown[]) => any;
  select: (...args: unknown[]) => any;
  transaction: (...args: unknown[]) => any;
  update: (...args: unknown[]) => any;
  exec?: (...args: unknown[]) => any;
}

const databaseCache = new WeakMap<object, DatabaseClient>();

function createDatabaseClient(env: DatabaseEnv): DatabaseClient {
  if (env.DB) {
    return drizzleD1(env.DB, { schema }) as unknown as DatabaseClient;
  }

  const sqliteDatabase = createSqliteDatabase(env);
  return drizzle(sqliteDatabase, { schema }) as unknown as DatabaseClient;
}

export function getDb(env: DatabaseEnv = process.env): DatabaseClient {
  if (env === process.env) {
    return db;
  }

  const cacheKey = env as object;
  const cached = databaseCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const client = createDatabaseClient(env);
  databaseCache.set(cacheKey, client);
  return client;
}
