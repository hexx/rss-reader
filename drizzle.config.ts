import type { Config } from 'drizzle-kit';

export default {
  dbCredentials: {
    url: process.env.DATABASE_URL ?? './data/rss-reader.sqlite',
  },
  dialect: 'sqlite',
  out: './drizzle',
  schema: './src/db/schema.ts',
  strict: true,
  verbose: true,
} satisfies Config;
