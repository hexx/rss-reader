import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { subscriptions } from './db/schema.js';

async function setupDatabase() {
  const { sqlite, db } = await import('./db/index.js');

  sqlite.exec(`
    DROP TABLE IF EXISTS subscriptions;
    CREATE TABLE subscriptions (
      id TEXT PRIMARY KEY,
      site_url TEXT NOT NULL UNIQUE,
      title TEXT,
      added_at INTEGER NOT NULL DEFAULT 0
    );
  `);

  return db;
}

describe('cli subscription commands', () => {
  beforeEach(() => {
    vi.stubEnv('DATABASE_URL', ':memory:');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('subscribes with a default title and unsubscribes again', async () => {
    const db = await setupDatabase();
    const { subscribeSite, unsubscribeSite } = await import('./cli.js');

    await subscribeSite('https://example.com/feed');

    const rowsAfterSubscribe = await db.select().from(subscriptions);
    expect(rowsAfterSubscribe).toHaveLength(1);
    expect(rowsAfterSubscribe[0]).toMatchObject({
      siteUrl: 'https://example.com/feed',
      title: 'example.com',
    });

    await unsubscribeSite('https://example.com/feed');

    const rowsAfterUnsubscribe = await db.select().from(subscriptions);
    expect(rowsAfterUnsubscribe).toHaveLength(0);
  });
});
