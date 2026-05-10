import 'dotenv/config';

import type { Config } from 'drizzle-kit';

export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? './data/rss-reader.sqlite',
  },
  strict: true,
  verbose: true,
} satisfies Config;

