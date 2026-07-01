import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestDatabase } from './test-utils/sqljs-db.js';
import { server } from './test/setup.js';

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
        addedAt: new Date('2024-01-03T00:00:00.000Z'),
        id: 'subscription-1',
        siteUrl: 'https://example.com/feed.xml',
        title: 'Example Feed',
      },
      {
        addedAt: new Date('2024-01-02T00:00:00.000Z'),
        id: 'subscription-2',
        siteUrl: 'https://example.com/other.xml',
        title: 'Example Feed',
      },
      {
        addedAt: new Date('2024-01-01T00:00:00.000Z'),
        id: 'subscription-3',
        siteUrl: 'https://third.example/rss.xml',
        title: null,
      },
    ]);

    await testDb.insert(articles).values([
      {
        content: '本文',
        hatenaSummary: '反応要約',
        id: 'article-1',
        isRead: false,
        publishedAt: new Date('2024-01-01T00:00:00.000Z'),
        siteUrl: 'https://example.com/feed.xml',
        summary: '本文要約',
        title: '最初の記事',
        url: 'https://example.com/articles/1',
      },
      {
        content: '本文2',
        hatenaSummary: null,
        id: 'article-2',
        isRead: true,
        publishedAt: new Date('2024-01-02T00:00:00.000Z'),
        siteUrl: 'https://example.com/feed.xml',
        summary: '別の要約',
        title: '二番目の記事',
        url: 'https://example.com/articles/2',
      },
      {
        content: '本文3',
        hatenaSummary: null,
        id: 'article-3',
        isRead: true,
        publishedAt: new Date('2024-01-03T00:00:00.000Z'),
        siteUrl: 'https://example.com/other.xml',
        summary: '別の要約',
        title: '別の記事',
        url: 'https://example.com/articles/3',
      },
    ]);

    await testDb.insert(hatenaBookmarks).values({
      articleId: 'article-1',
      comment: '参考になる',
      id: 'bookmark-1',
      user: 'alice',
    });

    const articlesResponse = await app.fetch(new Request('http://localhost/api/articles'));
    const articlesPayload = (await articlesResponse.json()) as {
      articles: { title: string; url: string; bookmarks: Array<{ comment: string }> }[];
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
      articles: { title: string; url: string }[];
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
      articles: { title: string; url: string }[];
    };
    expect(pagedResponse.ok).toBe(true);
    expect(pagedPayload.articles).toHaveLength(1);
    expect(pagedPayload.articles[0]).toMatchObject({
      title: '二番目の記事',
      url: 'https://example.com/articles/2',
    });

    const sourcesResponse = await app.fetch(new Request('http://localhost/api/sources'));
    const sourcesPayload = (await sourcesResponse.json()) as {
      sources: {
        articleCount: number;
        displayTitle: string;
        id: string;
        siteUrl: string;
        title: string;
        unreadCount: number;
      }[];
    };
    expect(sourcesResponse.ok).toBe(true);
    expect(sourcesPayload.sources).toEqual([
      {
        articleCount: 2,
        displayTitle: 'Example Feed (FEED)',
        id: 'subscription-1',
        siteUrl: 'https://example.com/feed.xml',
        title: 'Example Feed',
        unreadCount: 1,
      },
      {
        articleCount: 1,
        displayTitle: 'Example Feed (OTHER)',
        id: 'subscription-2',
        siteUrl: 'https://example.com/other.xml',
        title: 'Example Feed',
        unreadCount: 0,
      },
      {
        articleCount: 0,
        displayTitle: 'third.example',
        id: 'subscription-3',
        siteUrl: 'https://third.example/rss.xml',
        title: 'third.example',
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

    const expected = new Map<string, { id: string; user: string; comment: string; createdAt: string }[]>();
    expected.set('article-1', [
      { comment: 'first', createdAt: '2024-01-01T00:00:00.000Z', id: 'bookmark-1', user: 'alice' },
    ]);
    expected.set('article-51', [
      { comment: 'second', createdAt: '2024-01-02T00:00:00.000Z', id: 'bookmark-2', user: 'bob' },
    ]);
    expected.set('article-101', [
      { comment: 'third', createdAt: '2024-01-03T00:00:00.000Z', id: 'bookmark-3', user: 'carol' },
    ]);

    // OrderBy が thenable として結果を返す（Drizzle の QueryPromise に相当）
    const orderByMock = vi
      .fn()
      .mockResolvedValueOnce([bookmarkRows[0]])
      .mockResolvedValueOnce([bookmarkRows[1]])
      .mockResolvedValueOnce([bookmarkRows[2]]);
    const whereMock = vi.fn(() => ({ orderBy: orderByMock }));
    const fromMock = vi.fn(() => ({ where: whereMock }));
    const selectMock = vi.fn(() => ({ from: fromMock }));
    const database = { select: selectMock } as unknown as Parameters<typeof fetchBookmarksByArticleIds>[0];

    const articleIds = Array.from({ length: 101 }, (_, index) => `article-${index + 1}`);
    const results = await fetchBookmarksByArticleIds(database, articleIds);

    expect(selectMock).toHaveBeenCalledTimes(3);
    expect(whereMock).toHaveBeenCalledTimes(3);
    expect(results).toEqual(expected);
  });

  it('creates subscriptions through the worker API', async () => {
    server.use(
      http.get('https://example.com/feed', () =>
        HttpResponse.text('<?xml version="1.0"?><rss version="2.0"><channel><title>Example</title></channel></rss>', {
          headers: { 'Content-Type': 'application/rss+xml' },
        }),
      ),
    );

    const response = await app.fetch(
      new Request('http://localhost/api/subscriptions', {
        body: JSON.stringify({ siteUrl: 'https://example.com/feed' }),
        headers: {
          'Content-Type': 'application/json',
        },
        method: 'POST',
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      alreadyAFeed: true,
      feedType: 'rss',
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

  it('auto-discovers RSS feed URLs from regular web pages', async () => {
    const blogHtml = `<!doctype html>
<html>
  <head>
    <title>My Blog</title>
    <link rel="alternate" type="application/rss+xml" title="My Blog RSS" href="/feed.xml" />
    <link rel="alternate" type="application/atom+xml" title="My Blog Atom" href="/atom.xml" />
  </head>
  <body><h1>My Blog</h1></body>
</html>`;

    server.use(
      http.get('https://blog.example.com/', () =>
        HttpResponse.text(blogHtml, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
      ),
      http.get('https://blog.example.com/feed.xml', () =>
        HttpResponse.text('<?xml version="1.0"?><rss version="2.0"><channel><title>Blog</title></channel></rss>', {
          headers: { 'Content-Type': 'application/rss+xml' },
        }),
      ),
    );

    const response = await app.fetch(
      new Request('http://localhost/api/subscriptions', {
        body: JSON.stringify({ siteUrl: 'https://blog.example.com/' }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      alreadyAFeed: false,
      feedType: 'rss',
      siteUrl: 'https://blog.example.com/feed.xml',
    });

    const savedSubscriptions = await testDb.select().from(subscriptions);
    expect(savedSubscriptions).toHaveLength(1);
    expect(savedSubscriptions[0]).toMatchObject({
      siteUrl: 'https://blog.example.com/feed.xml',
    });
  });

  it('prefers atom feed when only atom is advertised', async () => {
    const blogHtml = `<!doctype html>
<html>
  <head>
    <link rel="alternate" type="application/atom+xml" href="/atom.xml" />
  </head>
  <body></body>
</html>`;

    server.use(
      http.get('https://atom.example.com/', () =>
        HttpResponse.text(blogHtml, { headers: { 'Content-Type': 'text/html' } }),
      ),
    );

    const response = await app.fetch(
      new Request('http://localhost/api/subscriptions', {
        body: JSON.stringify({ siteUrl: 'https://atom.example.com/' }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      alreadyAFeed: false,
      feedType: 'atom',
      siteUrl: 'https://atom.example.com/atom.xml',
    });
  });

  it('returns 400 when no feed can be discovered', async () => {
    server.use(
      http.get('https://nofeed.example.com/', () =>
        HttpResponse.text('<!doctype html><html><body>no feed here</body></html>', {
          headers: { 'Content-Type': 'text/html' },
        }),
      ),
    );

    const response = await app.fetch(
      new Request('http://localhost/api/subscriptions', {
        body: JSON.stringify({ siteUrl: 'https://nofeed.example.com/' }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toContain('RSSフィードを検出');

    const savedSubscriptions = await testDb.select().from(subscriptions);
    expect(savedSubscriptions).toHaveLength(0);
  });

  it('returns 400 for internal hostnames to prevent SSRF', async () => {
    const response = await app.fetch(
      new Request('http://localhost/api/subscriptions', {
        body: JSON.stringify({ siteUrl: 'http://127.0.0.1/' }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toContain('RSSフィードを検出');
  });

  it('updates article read state through the article route', async () => {
    await testDb.insert(articles).values({
      content: '本文',
      hatenaSummary: null,
      id: 'article-1',
      isRead: false,
      publishedAt: new Date('2024-01-01T00:00:00.000Z'),
      siteUrl: 'https://example.com/feed.xml',
      summary: '本文要約',
      title: '最初の記事',
      url: 'https://example.com/articles/1',
    });

    const response = await app.fetch(
      new Request('http://localhost/api/articles/article-1', {
        body: JSON.stringify({ isRead: true }),
        headers: {
          'Content-Type': 'application/json',
        },
        method: 'PATCH',
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

  it('rejects non-object request bodies with 400', async () => {
    await testDb.insert(articles).values({
      content: '本文',
      hatenaSummary: null,
      id: 'article-1',
      isRead: false,
      publishedAt: new Date('2024-01-01T00:00:00.000Z'),
      siteUrl: 'https://example.com/feed.xml',
      summary: '要約',
      title: '記事',
      url: 'https://example.com/articles/1',
    });

    const cases: { method: 'POST' | 'DELETE' | 'PATCH'; pathname: string; body: string }[] = [
      { body: 'null', method: 'POST', pathname: '/api/subscriptions' },
      { body: 'null', method: 'DELETE', pathname: '/api/subscriptions' },
      { body: 'null', method: 'PATCH', pathname: '/api/articles/article-1' },
    ];

    for (const { method, pathname, body } of cases) {
      const response = await app.fetch(
        new Request(`http://localhost${pathname}`, {
          body,
          headers: { 'Content-Type': 'application/json' },
          method,
        }),
      );
      const {status} = response;
      const responseBody = (await response.json()) as { error?: string };
      expect({ error: responseBody.error, method, pathname, status }).toEqual({
        error: 'Request body must be a JSON object.',
        method,
        pathname,
        status: 400,
      });
    }
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

    syncAllSubscriptionsMock.mockResolvedValue();

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

    syncAllSubscriptionsMock.mockResolvedValue();
    const workerModule = await import('./worker.js');

    await workerModule.default.scheduled({} as never, env as never, executionContext as never);

    expect(syncAllSubscriptionsMock).toHaveBeenCalledWith(false, env, true);
    expect(executionContext.waitUntil).toHaveBeenCalledTimes(1);
  });

  it('updates article read state through the /read sub-path', async () => {
    await testDb.insert(articles).values({
      content: '本文',
      hatenaSummary: null,
      id: 'article-read',
      isRead: false,
      publishedAt: new Date('2024-01-01T00:00:00.000Z'),
      siteUrl: 'https://example.com/feed.xml',
      summary: '要約',
      title: 'read article',
      url: 'https://example.com/articles/read',
    });

    const response = await app.fetch(
      new Request('http://localhost/api/articles/article-read/read', {
        body: JSON.stringify({ isRead: true }),
        headers: { 'Content-Type': 'application/json' },
        method: 'PATCH',
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: 'article-read',
      isRead: true,
    });
  });

  it('returns 404 when deleting a non-existent subscription', async () => {
    const response = await app.fetch(
      new Request('http://localhost/api/subscriptions', {
        body: JSON.stringify({ siteUrl: 'https://nonexistent.example/feed.xml' }),
        headers: { 'Content-Type': 'application/json' },
        method: 'DELETE',
      }),
    );

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe('Subscription not found.');
  });

  describe('article sorting', () => {
    beforeEach(async () => {
      await testDb.insert(subscriptions).values([
        {
          addedAt: new Date('2024-01-01T00:00:00.000Z'),
          id: 'sub-sort',
          siteUrl: 'https://example.com/feed.xml',
          title: 'Sort Test',
        },
      ]);

      await testDb.insert(articles).values([
        {
          content: '',
          hatenaSummary: null,
          id: 'article-old',
          isRead: false,
          publishedAt: new Date('2024-01-01T00:00:00.000Z'),
          siteUrl: 'https://example.com/feed.xml',
          summary: '',
          title: 'Old Article',
          url: 'https://example.com/old',
        },
        {
          content: '',
          hatenaSummary: null,
          id: 'article-new',
          isRead: false,
          publishedAt: new Date('2024-01-10T00:00:00.000Z'),
          siteUrl: 'https://example.com/feed.xml',
          summary: '',
          title: 'New Article',
          url: 'https://example.com/new',
        },
      ]);
    });

    it('defaults sort to asc when sort parameter is missing', async () => {
      const response = await app.fetch(
        new Request('http://localhost/api/articles?unread_only=false'),
      );
      const body = (await response.json()) as { articles: { title: string }[] };
      expect(body.articles[0]?.title).toBe('Old Article');
      expect(body.articles[1]?.title).toBe('New Article');
    });

    it('sorts articles by desc when specified', async () => {
      const response = await app.fetch(
        new Request('http://localhost/api/articles?unread_only=false&sort=desc'),
      );
      const body = (await response.json()) as { articles: { title: string }[] };
      expect(body.articles[0]?.title).toBe('New Article');
      expect(body.articles[1]?.title).toBe('Old Article');
    });

    it('falls back to asc for invalid sort parameter', async () => {
      const response = await app.fetch(
        new Request('http://localhost/api/articles?unread_only=false&sort=invalid'),
      );
      const body = (await response.json()) as { articles: { title: string }[] };
      expect(body.articles[0]?.title).toBe('Old Article');
      expect(body.articles[1]?.title).toBe('New Article');
    });
  });
});
