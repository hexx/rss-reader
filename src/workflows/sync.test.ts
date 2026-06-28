import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeEnv } from '../env.js';
import { articles, hatenaBookmarks, subscriptions } from '../db/schema.js';
import { createTestDatabase } from '../test-utils/sqljs-db.js';

const testEnv = {} as RuntimeEnv;

vi.mock('../services/scraper.js', () => ({
  fetchArticleContent: vi.fn(),
  fetchRssOrFallback: vi.fn(),
}));

vi.mock('../services/hatena.js', () => ({
  fetchHatenaBookmarks: vi.fn(),
}));

const { getDbMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(() => testDb),
}));

vi.mock('../db/index.js', () => ({
  getDb: getDbMock,
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../services/ai.js', async () => {
  const actual = await vi.importActual<typeof import('../services/ai.js')>('../services/ai.js');
  return {
    ...actual,
    generateArticleSummary: vi.fn(),
    generateHatenaSummary: vi.fn(),
  };
});

import { fetchHatenaBookmarks } from '../services/hatena.js';
import { generateArticleSummary, generateHatenaSummary } from '../services/ai.js';
import { fetchArticleContent, fetchRssOrFallback } from '../services/scraper.js';
import { logger } from '../utils/logger.js';

const fetchHatenaBookmarksMock = vi.mocked(fetchHatenaBookmarks);
const generateArticleSummaryMock = vi.mocked(generateArticleSummary);
const generateHatenaSummaryMock = vi.mocked(generateHatenaSummary);
const fetchArticleContentMock = vi.mocked(fetchArticleContent);
const fetchRssOrFallbackMock = vi.mocked(fetchRssOrFallback);
const loggerMock = vi.mocked(logger);

let testDb = (await createTestDatabase()).db;

const siteUrl = 'https://b.hatena.ne.jp/site/feed';
const nonHatenaSiteUrl = 'https://example.com/feed.xml';

const article = {
  title: '記事タイトル',
  pubDate: new Date('2024-01-01T00:00:00.000Z'),
  url: 'https://example.com/articles/1',
};

const secondArticle = {
  title: '記事タイトル2',
  pubDate: new Date('2024-01-02T00:00:00.000Z'),
  url: 'https://example.com/articles/2',
};

const thirdArticle = {
  title: '記事タイトル3',
  pubDate: new Date('2024-01-03T00:00:00.000Z'),
  url: 'https://example.com/articles/3',
};

const bookmarks = [
  {
    comment: '参考になる',
    user: 'alice',
  },
];

describe('syncSite', () => {
  beforeEach(async () => {
    vi.resetModules();
    testDb = (await createTestDatabase()).db;

    fetchHatenaBookmarksMock.mockReset();
    generateArticleSummaryMock.mockReset();
    generateHatenaSummaryMock.mockReset();
    fetchArticleContentMock.mockReset();
    fetchRssOrFallbackMock.mockReset();
    loggerMock.info.mockReset();
    loggerMock.warn.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('stores new articles, comments, and summaries even when content is empty', async () => {
    const { syncSite } = await import('./sync.js');

    fetchRssOrFallbackMock.mockResolvedValue([article]);
    fetchArticleContentMock.mockResolvedValue('');
    fetchHatenaBookmarksMock.mockResolvedValue(bookmarks);
    generateArticleSummaryMock.mockResolvedValue('要約文');
    generateHatenaSummaryMock.mockResolvedValue('はてブ要約');

    await expect(syncSite(siteUrl, false, testEnv, false)).resolves.toBe(1);

    const savedArticles = await testDb.select().from(articles);
    const savedBookmarks = await testDb.select().from(hatenaBookmarks);

    expect(savedArticles).toHaveLength(1);
    expect(savedArticles[0]).toMatchObject({
      content: '',
      hatenaSummary: 'はてブ要約',
      isRead: false,
      publishedAt: new Date('2024-01-01T00:00:00.000Z'),
      summary: '要約文',
      siteUrl,
      title: article.title,
      url: article.url,
    });
    expect(savedBookmarks).toHaveLength(1);
    expect(savedBookmarks[0]).toMatchObject({
      comment: '参考になる',
      user: 'alice',
    });
    expect(fetchArticleContentMock).toHaveBeenCalledWith(article.url);
    expect(fetchHatenaBookmarksMock).toHaveBeenCalledWith(article.url);
    expect(generateArticleSummaryMock).toHaveBeenCalledWith(article.title, '', expect.any(Object));
    expect(generateHatenaSummaryMock).toHaveBeenCalledWith(bookmarks, expect.any(Object));
    expect(loggerMock.info).toHaveBeenCalledWith('記事の同期処理を実行します。', {
      title: article.title,
      url: article.url,
    });
  });

  it('skips Hatena bookmarks for non-Hatena sites', async () => {
    const { syncSite } = await import('./sync.js');

    fetchRssOrFallbackMock.mockResolvedValue([article]);
    fetchArticleContentMock.mockResolvedValue('本文の内容です。');
    generateArticleSummaryMock.mockResolvedValue('要約文');

    await syncSite(nonHatenaSiteUrl, false, testEnv, false);

    expect(fetchHatenaBookmarksMock).not.toHaveBeenCalled();
    expect(generateHatenaSummaryMock).not.toHaveBeenCalled();

    const savedArticles = await testDb.select().from(articles);
    const savedBookmarks = await testDb.select().from(hatenaBookmarks);

    expect(savedArticles).toHaveLength(1);
    expect(savedArticles[0]).toMatchObject({
      hatenaSummary: null,
      siteUrl: nonHatenaSiteUrl,
      summary: '要約文',
      title: article.title,
      url: article.url,
    });
    expect(savedBookmarks).toHaveLength(0);
  });

  it('falls back to empty content when article fetch fails', async () => {
    const { syncSite } = await import('./sync.js');

    fetchRssOrFallbackMock.mockResolvedValue([article]);
    fetchArticleContentMock.mockRejectedValueOnce(new Error('scrape failed'));
    fetchHatenaBookmarksMock.mockResolvedValue([{ user: 'bob', comment: '面白い' }]);
    generateArticleSummaryMock.mockResolvedValue('要約文');
    generateHatenaSummaryMock.mockResolvedValue('反応の要約');

    await expect(syncSite(siteUrl, false, testEnv, false)).resolves.toBe(1);

    const savedArticles = await testDb.select().from(articles);
    expect(savedArticles).toHaveLength(1);
    expect(savedArticles[0]).toMatchObject({
      content: '',
      hatenaSummary: '反応の要約',
      summary: '要約文',
      siteUrl,
      title: article.title,
      url: article.url,
    });
    expect(fetchArticleContentMock).toHaveBeenCalledWith(article.url);
    expect(fetchHatenaBookmarksMock).toHaveBeenCalledWith(article.url);
    expect(generateArticleSummaryMock).toHaveBeenCalledWith(article.title, '', expect.any(Object));
    expect(generateHatenaSummaryMock).toHaveBeenCalledWith([{ user: 'bob', comment: '面白い' }], expect.any(Object));
    expect(loggerMock.warn).toHaveBeenCalledWith(
      '本文の取得に失敗したため、本文なしで処理を継続します。',
      expect.objectContaining({
        articleUrl: article.url,
        siteUrl,
        title: article.title,
        error: 'scrape failed',
      }),
    );
  });

  it('fails fast in debug mode when an article sync fails', async () => {
    const { syncSite } = await import('./sync.js');
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    fetchRssOrFallbackMock.mockResolvedValue([article]);
    fetchArticleContentMock.mockResolvedValue('本文の内容です。');
    generateArticleSummaryMock.mockRejectedValue(new Error('summary failed'));

    await expect(syncSite(siteUrl, true, testEnv, false)).rejects.toThrow('summary failed');

    expect(fetchHatenaBookmarksMock).toHaveBeenCalledWith(article.url);
    expect(generateHatenaSummaryMock).not.toHaveBeenCalled();
    expect(loggerMock.warn).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('summary failed'));

    consoleErrorSpy.mockRestore();
  });

  it('continues with subsequent articles when an article fails in non-debug mode', async () => {
    const { syncSite } = await import('./sync.js');

    fetchRssOrFallbackMock.mockResolvedValue([article, secondArticle]);
    fetchArticleContentMock.mockResolvedValue('本文');
    fetchHatenaBookmarksMock.mockResolvedValue(bookmarks);
    generateArticleSummaryMock
      .mockRejectedValueOnce(new Error('first failed'))
      .mockResolvedValueOnce('2件目の要約');
    generateHatenaSummaryMock.mockResolvedValue('はてブ要約');

    await expect(syncSite(siteUrl, false, testEnv, false)).resolves.toBe(1);

    const savedArticles = await testDb.select().from(articles);
    expect(savedArticles).toHaveLength(1);
    expect(savedArticles[0]?.title).toBe(secondArticle.title);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      '記事の同期に失敗しました。',
      expect.objectContaining({ error: 'first failed' }),
    );
  });

  it('does not re-insert articles that already exist', async () => {
    const { syncSite } = await import('./sync.js');

    fetchRssOrFallbackMock.mockResolvedValue([article]);
    fetchArticleContentMock.mockResolvedValue('本文');
    fetchHatenaBookmarksMock.mockResolvedValue(bookmarks);
    generateArticleSummaryMock.mockResolvedValue('要約文');
    generateHatenaSummaryMock.mockResolvedValue('はてブ要約');

    await syncSite(siteUrl, false, testEnv, false);
    await syncSite(siteUrl, false, testEnv, false);

    const savedArticles = await testDb.select().from(articles);
    expect(savedArticles).toHaveLength(1);
    expect(generateArticleSummaryMock).toHaveBeenCalledTimes(1);
  });

  it('stops processing once the manual sync limit is reached', async () => {
    const { syncSite } = await import('./sync.js');

    fetchRssOrFallbackMock.mockResolvedValue([article, secondArticle, thirdArticle]);
    fetchArticleContentMock.mockResolvedValue('本文');
    fetchHatenaBookmarksMock.mockResolvedValue(bookmarks);
    generateArticleSummaryMock.mockResolvedValue('要約文');
    generateHatenaSummaryMock.mockResolvedValue('はてブ要約');

    await expect(syncSite(siteUrl, false, testEnv, false)).resolves.toBe(2);

    const savedArticles = await testDb.select().from(articles);
    expect(savedArticles).toHaveLength(2);
    expect(loggerMock.info).toHaveBeenCalledWith('タイムアウト防止のため、記事の同期を中断して次回に回します。');
  });

  it('continues processing in cron mode without the manual limit', async () => {
    const { syncSite } = await import('./sync.js');

    fetchRssOrFallbackMock.mockResolvedValue([article, secondArticle, thirdArticle]);
    fetchArticleContentMock.mockResolvedValue('本文');
    fetchHatenaBookmarksMock.mockResolvedValue(bookmarks);
    generateArticleSummaryMock.mockResolvedValue('要約文');
    generateHatenaSummaryMock.mockResolvedValue('はてブ要約');

    await expect(syncSite(siteUrl, false, testEnv, true)).resolves.toBe(3);

    const savedArticles = await testDb.select().from(articles);
    expect(savedArticles).toHaveLength(3);
  });
});

describe('syncAllSubscriptions', () => {
  beforeEach(async () => {
    vi.resetModules();
    testDb = (await createTestDatabase()).db;

    fetchHatenaBookmarksMock.mockReset();
    generateArticleSummaryMock.mockReset();
    generateHatenaSummaryMock.mockReset();
    fetchArticleContentMock.mockReset();
    fetchRssOrFallbackMock.mockReset();
    loggerMock.info.mockReset();
    loggerMock.warn.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns early when there are no subscriptions', async () => {
    const { syncAllSubscriptions } = await import('./sync.js');

    await syncAllSubscriptions(false, testEnv, false);

    expect(fetchRssOrFallbackMock).not.toHaveBeenCalled();
    expect(loggerMock.info).toHaveBeenCalledWith('購読サイトがありません。');
  });

  it('splits hatena bookmark inserts into chunks of 20', async () => {
    const manyBookmarks = Array.from({ length: 25 }, (_, index) => ({
      user: `user-${index}`,
      comment: `comment-${index}`,
    }));

    await testDb.insert(subscriptions).values([
      { id: 'subscription-1', siteUrl },
    ]);

    fetchRssOrFallbackMock.mockResolvedValue([article]);
    fetchArticleContentMock.mockResolvedValue('本文');
    fetchHatenaBookmarksMock.mockResolvedValue(manyBookmarks);
    generateArticleSummaryMock.mockResolvedValue('要約文');
    generateHatenaSummaryMock.mockResolvedValue('はてブ要約');

    const { syncAllSubscriptions } = await import('./sync.js');
    await syncAllSubscriptions(false, testEnv, false);

    const savedBookmarks = await testDb.select().from(hatenaBookmarks);
    expect(savedBookmarks).toHaveLength(25);
  });

  it('syncs each subscribed site', async () => {
    await testDb.insert(subscriptions).values([
      { id: 'subscription-1', siteUrl },
      { id: 'subscription-2', siteUrl: nonHatenaSiteUrl },
    ]);

    fetchRssOrFallbackMock.mockImplementation(async (targetUrl) =>
      targetUrl === siteUrl ? [article] : [secondArticle],
    );
    fetchArticleContentMock.mockResolvedValue('本文');
    fetchHatenaBookmarksMock.mockResolvedValue(bookmarks);
    generateArticleSummaryMock.mockResolvedValue('要約文');
    generateHatenaSummaryMock.mockResolvedValue('はてブ要約');

    const { syncAllSubscriptions } = await import('./sync.js');
    await syncAllSubscriptions(false, testEnv, true);

    const savedArticles = await testDb.select().from(articles);
    expect(savedArticles).toHaveLength(2);
    expect(savedArticles.map((row) => row.title).sort()).toEqual([article.title, secondArticle.title].sort());
  });
});
