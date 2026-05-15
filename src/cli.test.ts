import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { subscriptions } from './db/schema.js';
import { createTestDatabase } from './test-utils/sqljs-db.js';

let testDb: Awaited<ReturnType<typeof createTestDatabase>>['db'];

const { getDbMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(() => testDb),
}));

vi.mock('./db/index.js', () => ({
  getDb: getDbMock,
}));

describe('cli subscription commands', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv('VITEST', 'true');
    testDb = (await createTestDatabase()).db;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('subscribes with a default title and unsubscribes again', async () => {
    const { subscribeSite, unsubscribeSite } = await import('./cli.js');

    await subscribeSite('https://example.com/feed');

    const rowsAfterSubscribe = await testDb.select().from(subscriptions);
    expect(rowsAfterSubscribe).toHaveLength(1);
    expect(rowsAfterSubscribe[0]).toMatchObject({
      siteUrl: 'https://example.com/feed',
      title: 'example.com',
    });

    await unsubscribeSite('https://example.com/feed');

    const rowsAfterUnsubscribe = await testDb.select().from(subscriptions);
    expect(rowsAfterUnsubscribe).toHaveLength(0);
  }, 10_000);
});
