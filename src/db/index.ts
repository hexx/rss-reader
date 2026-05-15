import 'dotenv/config';

import type { D1Database } from '@cloudflare/workers-types';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';

import type { RuntimeEnv } from '../env.js';
import * as schema from './schema.js';

type DatabaseEnv = RuntimeEnv & {
  DB?: D1Database;
};

export function getDb(env: DatabaseEnv) {
  if (!env.DB) {
    throw new Error('DB binding is required.');
  }

  return drizzleD1(env.DB, { schema });
}
