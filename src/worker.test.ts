import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./services/search.js', () => ({
  searchArticles: vi.fn(),
}));

vi.mock('./workflows/sync.js', () => ({
  syncAllSubscriptions: vi.fn(),
}));

vi.mock('./services/ai.js', async () => {
  const actual = await vi.importActual<typeof import('./services/ai.js')>('./services/ai.js');
  return {
    ...actual,
    generateRagAnswer: vi.fn(),
  };
});

import { articles, hatenaBookmarks, subscriptions } from './db/schema.js';
import { createSqliteDatabase, getDb } from './db/index.js';
import { getVectorCollection } from './db/vector.js';
import { generateRagAnswer } from './services/ai.js';
import { searchArticles } from './services/search.js';
import { syncAllSubscriptions } from './workflows/sync.js';

const searchArticlesMock = vi.mocked(searchArticles);
const generateRagAnswerMock = vi.mocked(generateRagAnswer);
const syncAllSubscriptionsMock = vi.mocked(syncAllSubscriptions);

let vectorPath = '';
let app: typeof import('./worker.js').app;

async function loadWorkerApp() {
  const module = await import('./worker.js');
  return module.app;
}

async function setupDatabase(env: { DATABASE_URL: string }) {
  const sqlite = createSqliteDatabase(env);

  sqlite.exec(`
    CREATE TABLE articles (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL UNIQUE,
      site_url TEXT NOT NULL,
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
      article_id TEXT NOT NULL,
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

  return getDb(env);
}

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv('DATABASE_URL', ':memory:');
  searchArticlesMock.mockReset();
  generateRagAnswerMock.mockReset();
  syncAllSubscriptionsMock.mockReset();
  vectorPath = mkdtempSync(join(tmpdir(), 'rss-worker-vector-'));
  app = await loadWorkerApp();
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (vectorPath.length > 0) {
    rmSync(vectorPath, { recursive: true, force: true });
    vectorPath = '';
  }
});

describe('worker app', () => {
  it('responds to health checks', async () => {
    const response = await app.fetch(new Request('http://localhost/health'));

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('ok');
  });

  it('returns articles and sources from the worker database', async () => {
    const env = {
      DATABASE_URL: join(vectorPath, 'worker.sqlite'),
      VECTOR_DB_PATH: vectorPath,
    };
    const database = await setupDatabase(env);

    await database.insert(subscriptions).values([
      {
        id: 'subscription-1',
        siteUrl: 'https://example.com/',
        title: 'Example Feed',
      },
      {
        id: 'subscription-2',
        siteUrl: 'https://another.example/',
        title: null,
      },
    ]);

    await database.insert(articles).values([
      {
        id: 'article-1',
        siteUrl: 'https://example.com/',
        url: 'https://example.com/articles/1',
        title: '最初の記事',
        content: '本文',
        summary: '本文要約',
        hatenaSummary: '反応要約',
        isRead: false,
        publishedAt: new Date('2024-01-01T00:00:00.000Z'),
      },
      {
        id: 'article-2',
        siteUrl: 'https://another.example/',
        url: 'https://another.example/posts/2',
        title: '別の記事',
        content: '本文2',
        summary: '別の要約',
        hatenaSummary: null,
        isRead: true,
        publishedAt: new Date('2024-01-03T00:00:00.000Z'),
      },
    ]);

    await database.insert(hatenaBookmarks).values({
      id: 'bookmark-1',
      articleId: 'article-1',
      user: 'alice',
      comment: '参考になる',
    });

    const articlesResponse = await app.fetch(new Request('http://localhost/api/articles'), env as never);
    const articlesPayload = (await articlesResponse.json()) as {
      articles: Array<{ title: string; url: string; bookmarks: Array<{ comment: string }> }>;
    };
    expect(articlesResponse.ok).toBe(true);
    expect(articlesPayload.articles).toHaveLength(1);
    expect(articlesPayload.articles[0]).toMatchObject({
      bookmarks: [{ comment: '参考になる' }],
      title: '最初の記事',
      url: 'https://example.com/articles/1',
    });

    const sourcesResponse = await app.fetch(new Request('http://localhost/api/sources'), env as never);
    const sourcesPayload = (await sourcesResponse.json()) as {
      sources: Array<{ articleId: string | null; id: string; isRead: boolean; siteUrl: string; title: string }>;
    };
    expect(sourcesResponse.ok).toBe(true);
    expect(sourcesPayload.sources).toEqual([
      {
        articleId: 'article-1',
        id: 'subscription-1',
        isRead: false,
        siteUrl: 'https://example.com/',
        title: 'Example Feed',
      },
    ]);
  });

  it('threads env bindings into search and sync routes', async () => {
    const env = {
      DATABASE_URL: ':memory:',
      OPENCODE_GO_API_KEY: 'test-api-key',
      OPENCODE_GO_BASE_URL: 'https://opencode.example/v1',
      OPENCODE_GO_MODEL: 'test-model',
      VECTOR_DB_PATH: vectorPath,
      VECTOR_DIMENSION: '2',
    };

    searchArticlesMock.mockResolvedValue([
      {
        bookmarks: [],
        createdAt: '1970-01-01T00:00:00.000Z',
        id: 'article-1',
        hatenaSummary: 'はてブ要約',
        isRead: false,
        siteUrl: 'https://example.com/',
        summary: '記事要約',
        title: '検索対象の記事',
        url: 'https://example.com/articles/1',
      },
    ]);
    generateRagAnswerMock.mockResolvedValue('AIの回答');
    syncAllSubscriptionsMock.mockResolvedValue(undefined);

    const searchResponse = await app.fetch(new Request('http://localhost/api/search?q=検索語'), env as never);
    const searchPayload = (await searchResponse.json()) as { aiAnswer: string };

    expect(searchResponse.ok).toBe(true);
    expect(searchPayload.aiAnswer).toBe('AIの回答');
    expect(searchArticlesMock).toHaveBeenCalledWith('検索語', env);
    expect(generateRagAnswerMock).toHaveBeenCalledWith(
      '検索語',
      ['タイトル: 検索対象の記事\n記事要約: 記事要約\nはてブ要約: はてブ要約'],
      [
        {
          bookmarks: [],
          createdAt: '1970-01-01T00:00:00.000Z',
          id: 'article-1',
          hatenaSummary: 'はてブ要約',
          isRead: false,
          siteUrl: 'https://example.com/',
          summary: '記事要約',
          title: '検索対象の記事',
          url: 'https://example.com/articles/1',
        },
      ],
      env,
    );

    const syncResponse = await app.fetch(new Request('http://localhost/api/sync', { method: 'POST' }), env as never);
    expect(syncResponse.status).toBe(202);
    expect(syncAllSubscriptionsMock).toHaveBeenCalledWith(false, env);
  });
});
