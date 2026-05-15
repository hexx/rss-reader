import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let createSqliteDatabase: typeof import('./index.js').createSqliteDatabase;
let getDatabasePath: typeof import('./index.js').getDatabasePath;

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv('DATABASE_URL', ':memory:');

  ({ createSqliteDatabase, getDatabasePath } = await import('./index.js'));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('database env adapter', () => {
  it('resolves the sqlite path from env bindings', () => {
    expect(getDatabasePath({ DATABASE_URL: '/tmp/rss-reader.sqlite' })).toBe('/tmp/rss-reader.sqlite');
    expect(getDatabasePath({})).toBe('./sqlite.db');
  });

  it('creates a sqlite database from env bindings', () => {
    const sqlite = createSqliteDatabase({ DATABASE_URL: ':memory:' });

    expect(sqlite.prepare('select 1 as value').get()).toEqual({ value: 1 });

    sqlite.close();
  });
});
