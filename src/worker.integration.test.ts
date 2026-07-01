import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { articles, subscriptions } from './db/schema.js';
import { createTestDatabase } from './test-utils/sqljs-db.js';

// SyncAllSubscriptions の依存をモック（実際のネットワーク・AI呼び出しを避ける）
vi.mock('./services/scraper.js', () => ({
  discoverRssFeedUrl: vi.fn(),
  fetchArticleContent: vi.fn(),
  fetchRssOrFallback: vi.fn(),
}));

vi.mock('./services/hatena.js', () => ({
  fetchHatenaBookmarks: vi.fn(),
}));

vi.mock('./services/ai.js', () => ({
  generateArticleSummary: vi.fn(),
  generateHatenaSummary: vi.fn(),
}));

vi.mock('./utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

const { getDbMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(() => testDb),
}));

vi.mock('./db/index.js', () => ({
  getDb: getDbMock,
}));

import { discoverRssFeedUrl, fetchArticleContent, fetchRssOrFallback } from './services/scraper.js';
import { fetchHatenaBookmarks } from './services/hatena.js';
import { generateArticleSummary, generateHatenaSummary } from './services/ai.js';

const discoverRssFeedUrlMock = vi.mocked(discoverRssFeedUrl);
const fetchRssOrFallbackMock = vi.mocked(fetchRssOrFallback);
const fetchArticleContentMock = vi.mocked(fetchArticleContent);
const fetchHatenaBookmarksMock = vi.mocked(fetchHatenaBookmarks);
const generateArticleSummaryMock = vi.mocked(generateArticleSummary);
const generateHatenaSummaryMock = vi.mocked(generateHatenaSummary);

let testDb: Awaited<ReturnType<typeof createTestDatabase>>['db'];

describe('worker integration: sync -> articles flow', () => {
  let app: typeof import('./worker.js').app;

  beforeEach(async () => {
    vi.resetModules();
    testDb = (await createTestDatabase()).db;
    getDbMock.mockReset();
    getDbMock.mockImplementation(() => testDb);

    discoverRssFeedUrlMock.mockReset();
    fetchRssOrFallbackMock.mockReset();
    fetchArticleContentMock.mockReset();
    fetchHatenaBookmarksMock.mockReset();
    generateArticleSummaryMock.mockReset();
    generateHatenaSummaryMock.mockReset();

    const mod = await import('./worker.js');
    app = mod.app;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('completes the full sync flow: subscribe -> sync -> list articles -> mark as read', async () => {
    // --- Step 1: 購読を追加 ---
    discoverRssFeedUrlMock.mockResolvedValue({
      alreadyAFeed: true,
      feedUrl: 'https://example.com/feed.xml',
      type: 'rss',
    });

    const subResponse = await app.fetch(
      new Request('http://localhost/api/subscriptions', {
        body: JSON.stringify({ siteUrl: 'https://example.com/feed.xml' }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }),
    );
    expect(subResponse.status).toBe(201);

    const savedSubs = await testDb.select().from(subscriptions);
    expect(savedSubs).toHaveLength(1);

    // --- Step 2: 同期を実行 ---
    fetchRssOrFallbackMock.mockResolvedValue([
      {
        pubDate: new Date('2024-01-01T00:00:00.000Z'),
        title: '同期記事',
        url: 'https://example.com/articles/1',
      },
    ]);
    fetchArticleContentMock.mockResolvedValue('<p>同期本文</p>');
    fetchHatenaBookmarksMock.mockResolvedValue([
      { comment: '参考になる', timestamp: new Date('2024-01-01T00:00:00.000Z'), user: 'alice' },
    ]);
    generateArticleSummaryMock.mockResolvedValue('<p>要約</p>');
    generateHatenaSummaryMock.mockResolvedValue('<p>はてブ要約</p>');

    const syncResponse = await app.fetch(
      new Request('http://localhost/api/sync', { method: 'POST' }),
      {} as never,
      { waitUntil: vi.fn() } as never,
    );
    expect(syncResponse.status).toBe(202);

    // Sync は非同期のため、記事が保存されるまで待機
    await vi.waitFor(async () => {
      const savedArticles = await testDb.select().from(articles);
      expect(savedArticles).toHaveLength(1);
    });

    // --- Step 3: 記事一覧を取得 ---
    const articlesResponse = await app.fetch(
      new Request('http://localhost/api/articles?unread_only=false'),
    );
    expect(articlesResponse.status).toBe(200);
    const articlesBody = (await articlesResponse.json()) as { articles: { title: string; summary: string }[] };
    expect(articlesBody.articles).toHaveLength(1);
    expect(articlesBody.articles[0]?.title).toBe('同期記事');
    expect(articlesBody.articles[0]?.summary).toBe('<p>要約</p>');

    // --- Step 4: 記事を既読化 ---
    const savedArticles = await testDb.select().from(articles);
    const articleId = savedArticles[0]!.id;

    const readResponse = await app.fetch(
      new Request(`http://localhost/api/articles/${articleId}`, {
        body: JSON.stringify({ isRead: true }),
        headers: { 'Content-Type': 'application/json' },
        method: 'PATCH',
      }),
    );
    expect(readResponse.status).toBe(200);
    await expect(readResponse.json()).resolves.toMatchObject({ id: articleId, isRead: true });

    // 未読のみモードで記事が消えていることを確認
    const unreadResponse = await app.fetch(
      new Request('http://localhost/api/articles?unread_only=true'),
    );
    const unreadBody = (await unreadResponse.json()) as { articles: unknown[] };
    expect(unreadBody.articles).toHaveLength(0);
  });

  it('uses the /read sub-path for updating article read state', async () => {
    await testDb.insert(articles).values({
      content: '',
      hatenaSummary: null,
      id: 'article-integration-read',
      isRead: false,
      publishedAt: new Date('2024-01-01T00:00:00.000Z'),
      siteUrl: 'https://example.com/feed.xml',
      summary: '',
      title: 'Read Path Test',
      url: 'https://example.com/articles/read-path',
    });

    const response = await app.fetch(
      new Request('http://localhost/api/articles/article-integration-read/read', {
        body: JSON.stringify({ isRead: true }),
        headers: { 'Content-Type': 'application/json' },
        method: 'PATCH',
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: 'article-integration-read',
      isRead: true,
    });
  });
});
