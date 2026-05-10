import 'dotenv/config';

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import * as schema from './schema.js';

export const databasePath = process.env.DATABASE_URL ?? './sqlite.db';

mkdirSync(dirname(databasePath), { recursive: true });

export const sqlite = new Database(databasePath);

sqlite.pragma('foreign_keys = ON');

export const db = drizzle(sqlite, { schema });
