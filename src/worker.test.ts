import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestDatabase } from './test-utils/sqljs-db.js';

vi.mock('./workflows/sync.js', () => ({
  syncAllSubscriptions: vi.fn(),
}));

let testDb: Awaited<ReturnType<typeof createTestDatabase>>['db'];

const { getDbMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(() => testDb),
}));

vi.mock('./db/index.js', () => ({
  getDb: getDbMock,
}));

import { articles, hatenaBookmarks, subscriptions } from './db/schema.js';
import { syncAllSubscriptions } from './workflows/sync.js';

const syncAllSubscriptionsMock = vi.mocked(syncAllSubscriptions);

let app: typeof import('./worker.js').app;

async function loadWorkerApp() {
  const module = await import('./worker.js');
  return module.app;
}

beforeEach(async () => {
  vi.resetModules();
  testDb = (await createTestDatabase()).db;
  getDbMock.mockReset();
  getDbMock.mockImplementation(() => testDb);
  syncAllSubscriptionsMock.mockReset();
  app = await loadWorkerApp();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('worker app', () => {
  it('responds to health checks', async () => {
    const response = await app.fetch(new Request('http://localhost/health'));

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('ok');
  });

  it('returns articles and sources from the worker database', async () => {
    await testDb.insert(subscriptions).values([
      {
        id: 'subscription-1',
        siteUrl: 'https://example.com/feed.xml',
        title: 'Example Feed',
        addedAt: new Date('2024-01-03T00:00:00.000Z'),
      },
      {
        id: 'subscription-2',
        siteUrl: 'https://example.com/other.xml',
        title: 'Example Feed',
        addedAt: new Date('2024-01-02T00:00:00.000Z'),
      },
      {
        id: 'subscription-3',
        siteUrl: 'https://third.example/rss.xml',
        title: null,
        addedAt: new Date('2024-01-01T00:00:00.000Z'),
      },
    ]);

    await testDb.insert(articles).values([
      {
        id: 'article-1',
        siteUrl: 'https://example.com/feed.xml',
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
        siteUrl: 'https://example.com/feed.xml',
        url: 'https://example.com/articles/2',
        title: '二番目の記事',
        content: '本文2',
        summary: '別の要約',
        hatenaSummary: null,
        isRead: true,
        publishedAt: new Date('2024-01-02T00:00:00.000Z'),
      },
      {
        id: 'article-3',
        siteUrl: 'https://example.com/other.xml',
        url: 'https://example.com/articles/3',
        title: '別の記事',
        content: '本文3',
        summary: '別の要約',
        hatenaSummary: null,
        isRead: true,
        publishedAt: new Date('2024-01-03T00:00:00.000Z'),
      },
    ]);

    await testDb.insert(hatenaBookmarks).values({
      id: 'bookmark-1',
      articleId: 'article-1',
      user: 'alice',
      comment: '参考になる',
    });

    const articlesResponse = await app.fetch(new Request('http://localhost/api/articles'));
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

    const sourceResponse = await app.fetch(
      new Request('http://localhost/api/articles?source=https://example.com/other.xml&unread_only=false'),
    );
    const sourcePayload = (await sourceResponse.json()) as {
      articles: Array<{ title: string; url: string }>;
    };
    expect(sourceResponse.ok).toBe(true);
    expect(sourcePayload.articles).toHaveLength(1);
    expect(sourcePayload.articles[0]).toMatchObject({
      title: '別の記事',
      url: 'https://example.com/articles/3',
    });

    const pagedResponse = await app.fetch(
      new Request('http://localhost/api/articles?unread_only=false&limit=1&offset=1'),
    );
    const pagedPayload = (await pagedResponse.json()) as {
      articles: Array<{ title: string; url: string }>;
    };
    expect(pagedResponse.ok).toBe(true);
    expect(pagedPayload.articles).toHaveLength(1);
    expect(pagedPayload.articles[0]).toMatchObject({
      title: '二番目の記事',
      url: 'https://example.com/articles/2',
    });

    const sourcesResponse = await app.fetch(new Request('http://localhost/api/sources'));
    const sourcesPayload = (await sourcesResponse.json()) as {
      sources: Array<{
        articleCount: number;
        displayTitle: string;
        id: string;
        siteUrl: string;
        title: string;
        unreadCount: number;
      }>;
    };
    expect(sourcesResponse.ok).toBe(true);
    expect(sourcesPayload.sources).toEqual([
      {
        id: 'subscription-1',
        siteUrl: 'https://example.com/feed.xml',
        title: 'Example Feed',
        displayTitle: 'Example Feed (FEED)',
        articleCount: 2,
        unreadCount: 1,
      },
      {
        id: 'subscription-2',
        siteUrl: 'https://example.com/other.xml',
        title: 'Example Feed',
        displayTitle: 'Example Feed (OTHER)',
        articleCount: 1,
        unreadCount: 0,
      },
      {
        id: 'subscription-3',
        siteUrl: 'https://third.example/rss.xml',
        title: 'third.example',
        displayTitle: 'third.example',
        articleCount: 0,
        unreadCount: 0,
      },
    ]);
  });

  it('chunks bookmark lookups for large article lists', async () => {
    const { fetchBookmarksByArticleIds } = await import('./worker.js');

    const bookmarkRows = [
      {
        articleId: 'article-1',
        comment: 'first',
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        id: 'bookmark-1',
        user: 'alice',
      },
      {
        articleId: 'article-51',
        comment: 'second',
        createdAt: new Date('2024-01-02T00:00:00.000Z'),
        id: 'bookmark-2',
        user: 'bob',
      },
      {
        articleId: 'article-101',
        comment: 'third',
        createdAt: new Date('2024-01-03T00:00:00.000Z'),
        id: 'bookmark-3',
        user: 'carol',
      },
    ];

    const whereMock = vi
      .fn()
      .mockResolvedValueOnce([bookmarkRows[0]])
      .mockResolvedValueOnce([bookmarkRows[1]])
      .mockResolvedValueOnce([bookmarkRows[2]]);
    const fromMock = vi.fn(() => ({ where: whereMock }));
    const selectMock = vi.fn(() => ({ from: fromMock }));
    const database = { select: selectMock } as unknown as Parameters<typeof fetchBookmarksByArticleIds>[0];

    const articleIds = Array.from({ length: 101 }, (_, index) => `article-${index + 1}`);
    const results = await fetchBookmarksByArticleIds(database, articleIds);

    expect(selectMock).toHaveBeenCalledTimes(3);
    expect(whereMock).toHaveBeenCalledTimes(3);
    expect(results).toEqual(bookmarkRows);
  });

  it('creates subscriptions through the worker API', async () => {
    const response = await app.fetch(
      new Request('http://localhost/api/subscriptions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ siteUrl: 'https://example.com/feed' }),
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      siteUrl: 'https://example.com/feed',
      title: 'example.com',
    });

    const savedSubscriptions = await testDb.select().from(subscriptions);
    expect(savedSubscriptions).toHaveLength(1);
    expect(savedSubscriptions[0]).toMatchObject({
      siteUrl: 'https://example.com/feed',
      title: 'example.com',
    });
  });

  it('updates article read state through the article route', async () => {
    await testDb.insert(articles).values({
      id: 'article-1',
      siteUrl: 'https://example.com/feed.xml',
      url: 'https://example.com/articles/1',
      title: '最初の記事',
      content: '本文',
      summary: '本文要約',
      hatenaSummary: null,
      isRead: false,
      publishedAt: new Date('2024-01-01T00:00:00.000Z'),
    });

    const response = await app.fetch(
      new Request('http://localhost/api/articles/article-1', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ isRead: true }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: 'article-1',
      isRead: true,
    });

    const savedArticles = await testDb.select().from(articles);
    expect(savedArticles[0]).toMatchObject({
      id: 'article-1',
      isRead: true,
    });
  });

  it('threads env bindings into sync routes', async () => {
    const env = {
      OPENCODE_GO_API_KEY: 'test-api-key',
      OPENCODE_GO_BASE_URL: 'https://opencode.example/v1',
      OPENCODE_GO_MODEL: 'test-model',
    };
    const executionContext = {
      waitUntil: vi.fn(),
    };

    syncAllSubscriptionsMock.mockResolvedValue(undefined);

    const syncResponse = await app.fetch(
      new Request('http://localhost/api/sync', { method: 'POST' }),
      env as never,
      executionContext as never,
    );
    expect(syncResponse.status).toBe(202);
    expect(syncAllSubscriptionsMock).toHaveBeenCalledWith(false, env, false);
    expect(executionContext.waitUntil).toHaveBeenCalledTimes(1);
  });

  it('surfaces missing-table failures from D1-backed article routes', async () => {
    const blankDb = (await createTestDatabase({ initializeSchema: false })).db;
    getDbMock.mockImplementation(() => blankDb);

    const articlesResponse = await app.fetch(new Request('http://localhost/api/articles'));
    const sourcesResponse = await app.fetch(new Request('http://localhost/api/sources'));

    expect(articlesResponse.status).toBe(500);
    expect(sourcesResponse.status).toBe(500);
  });

  it('uses cron mode for scheduled syncs', async () => {
    const env = {
      OPENCODE_GO_API_KEY: 'test-api-key',
      OPENCODE_GO_BASE_URL: 'https://opencode.example/v1',
      OPENCODE_GO_MODEL: 'test-model',
    };
    const executionContext = {
      waitUntil: vi.fn(),
    };

    syncAllSubscriptionsMock.mockResolvedValue(undefined);
    const workerModule = await import('./worker.js');

    await workerModule.default.scheduled({} as never, env as never, executionContext as never);

    expect(syncAllSubscriptionsMock).toHaveBeenCalledWith(false, env, true);
    expect(executionContext.waitUntil).toHaveBeenCalledTimes(1);
  });
});
