import 'dotenv/config';

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';
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
export const db = drizzle(sqlite, { schema });
