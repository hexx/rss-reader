import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { articles, hatenaBookmarks, subscriptions } from '../db/schema.js';
import { createTestDatabase } from '../test-utils/sqljs-db.js';

vi.mock('../services/scraper.js', () => ({
  fetchArticleContent: vi.fn(),
  fetchRssOrFallback: vi.fn(),
}));

vi.mock('../services/hatena.js', () => ({
  fetchHatenaBookmarks: vi.fn(),
}));

vi.mock('../db/vector.js', () => ({
  getVectorCollection: vi.fn(),
}));

const { getDbMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(() => testDb),
}));

vi.mock('../db/index.js', () => ({
  getDb: getDbMock,
}));

vi.mock('../utils/chunking.js', () => ({
  chunkText: vi.fn(),
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
    generateEmbeddings: vi.fn(),
    generateHatenaSummary: vi.fn(),
  };
});

import { fetchHatenaBookmarks } from '../services/hatena.js';
import { generateArticleSummary, generateEmbeddings, generateHatenaSummary } from '../services/ai.js';
import { fetchArticleContent, fetchRssOrFallback } from '../services/scraper.js';
import { getVectorCollection } from '../db/vector.js';
import { chunkText } from '../utils/chunking.js';
import { logger } from '../utils/logger.js';

const fetchHatenaBookmarksMock = vi.mocked(fetchHatenaBookmarks);
const generateArticleSummaryMock = vi.mocked(generateArticleSummary);
const generateEmbeddingsMock = vi.mocked(generateEmbeddings);
const generateHatenaSummaryMock = vi.mocked(generateHatenaSummary);
const fetchArticleContentMock = vi.mocked(fetchArticleContent);
const fetchRssOrFallbackMock = vi.mocked(fetchRssOrFallback);
const getVectorCollectionMock = vi.mocked(getVectorCollection);
const chunkTextMock = vi.mocked(chunkText);
const loggerMock = vi.mocked(logger);

let testDb: Awaited<ReturnType<typeof createTestDatabase>>['db'];

const siteUrl = 'https://b.hatena.ne.jp/entry/example.com/';
const nonHatenaSiteUrl = 'https://example.com/';
const article = {
  title: '記事タイトル',
  pubDate: new Date('2024-01-01T00:00:00.000Z'),
  url: 'https://example.com/articles/1',
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
    generateEmbeddingsMock.mockReset();
    generateHatenaSummaryMock.mockReset();
    fetchArticleContentMock.mockReset();
    fetchRssOrFallbackMock.mockReset();
    getVectorCollectionMock.mockReset();
    chunkTextMock.mockReset();
    loggerMock.info.mockReset();
    loggerMock.warn.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('stores new articles, comments, summaries, and embeddings even when content is empty', async () => {
    const vectorAddMock = vi.fn().mockResolvedValue(1);
    const { syncSite } = await import('./sync.js');

    fetchRssOrFallbackMock.mockResolvedValue([article]);
    fetchArticleContentMock.mockResolvedValue('');
    fetchHatenaBookmarksMock.mockResolvedValue(bookmarks);
    generateArticleSummaryMock.mockResolvedValue('要約文');
    generateHatenaSummaryMock.mockResolvedValue('はてブ要約');
    chunkTextMock.mockReturnValue(['chunk-1', 'chunk-2']);
    generateEmbeddingsMock.mockResolvedValue([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    getVectorCollectionMock.mockResolvedValue({ add: vectorAddMock } as never);

    await expect(syncSite(siteUrl)).resolves.toBe(1);

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
    expect(chunkTextMock).toHaveBeenCalledWith(
      'タイトル: 記事タイトル\n\n本文:',
      1500,
    );
    expect(generateEmbeddingsMock).toHaveBeenCalledWith(['chunk-1', 'chunk-2'], expect.any(Object));
    expect(vectorAddMock).toHaveBeenCalledWith([
      {
        article_id: expect.any(String),
        text: 'chunk-1',
        vector: [0.1, 0.2],
      },
      {
        article_id: expect.any(String),
        text: 'chunk-2',
        vector: [0.3, 0.4],
      },
    ]);
    expect(fetchArticleContentMock).toHaveBeenCalledWith(article.url);
    expect(fetchHatenaBookmarksMock).toHaveBeenCalledWith(article.url);
    expect(generateArticleSummaryMock).toHaveBeenCalledWith(article.title, '', expect.any(Object));
    expect(generateHatenaSummaryMock).toHaveBeenCalledWith(bookmarks, expect.any(Object));
    expect(generateEmbeddingsMock).toHaveBeenCalledTimes(1);
    const infoMessages = loggerMock.info.mock.calls.map(([message]) => String(message));
    expect(infoMessages).toEqual(
      expect.arrayContaining([
        expect.stringContaining('[計測] 本文取得:'),
        expect.stringContaining('[計測] はてなAPI:'),
        expect.stringContaining('[計測] 記事要約AI:'),
        expect.stringContaining('[計測] コメント要約AI:'),
        expect.stringContaining('[計測] ベクトル化AI:'),
      ]),
    );
    expect(loggerMock.info).toHaveBeenCalledWith('記事の同期処理を実行します。', {
      title: article.title,
      url: article.url,
    });
  });

  it('skips Hatena bookmarks for non-Hatena sites', async () => {
    const vectorAddMock = vi.fn().mockResolvedValue(1);
    const { syncSite } = await import('./sync.js');

    fetchRssOrFallbackMock.mockResolvedValue([article]);
    fetchArticleContentMock.mockResolvedValue('本文の内容です。');
    generateArticleSummaryMock.mockResolvedValue('要約文');
    chunkTextMock.mockReturnValue(['chunk-1']);
    generateEmbeddingsMock.mockResolvedValue([[0.1, 0.2]]);
    getVectorCollectionMock.mockResolvedValue({ add: vectorAddMock } as never);

    await syncSite(nonHatenaSiteUrl);

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
    expect(vectorAddMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to empty content when article fetch fails', async () => {
    const vectorAddMock = vi.fn().mockResolvedValue(1);
    const { syncSite } = await import('./sync.js');

    fetchRssOrFallbackMock.mockResolvedValue([article]);
    fetchArticleContentMock.mockRejectedValueOnce(new Error('scrape failed'));
    fetchHatenaBookmarksMock.mockResolvedValue([{ user: 'bob', comment: '面白い' }]);
    generateArticleSummaryMock.mockResolvedValue('要約文');
    generateHatenaSummaryMock.mockResolvedValue('反応の要約');
    chunkTextMock.mockReturnValue(['chunk-1']);
    generateEmbeddingsMock.mockResolvedValue([[0.1, 0.2]]);
    getVectorCollectionMock.mockResolvedValue({ add: vectorAddMock } as never);

    await expect(syncSite(siteUrl)).resolves.toBe(1);

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
    expect(generateEmbeddingsMock).toHaveBeenCalledTimes(1);
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
    const vectorAddMock = vi.fn().mockResolvedValue(1);
    const { syncSite } = await import('./sync.js');
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    fetchRssOrFallbackMock.mockResolvedValue([article]);
    fetchArticleContentMock.mockResolvedValue('本文の内容です。');
    generateArticleSummaryMock.mockRejectedValue(new Error('summary failed'));
    getVectorCollectionMock.mockResolvedValue({ add: vectorAddMock } as never);

    await expect(syncSite(siteUrl, true)).rejects.toThrow('summary failed');

    expect(fetchHatenaBookmarksMock).toHaveBeenCalledWith(article.url);
    expect(generateHatenaSummaryMock).not.toHaveBeenCalled();
    expect(generateEmbeddingsMock).not.toHaveBeenCalled();
    expect(vectorAddMock).not.toHaveBeenCalled();
    expect(loggerMock.warn).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('summary failed'));

    consoleErrorSpy.mockRestore();
    expect(await testDb.select().from(articles)).toHaveLength(0);
  });

  it('skips existing articles without refreshing Hatena data', async () => {
    const vectorAddMock = vi.fn().mockResolvedValue(1);
    const { syncSite } = await import('./sync.js');

    await testDb.insert(articles).values({
      id: 'existing-article',
      siteUrl,
      url: article.url,
      title: article.title,
      content: '本文',
      summary: '既存要約',
      hatenaSummary: '古いはてブ要約',
      publishedAt: new Date('2024-01-01T00:00:00.000Z'),
    });

    await testDb.insert(hatenaBookmarks).values({
      id: 'old-bookmark',
      articleId: 'existing-article',
      user: 'old',
      comment: '古いコメント',
    });

    fetchRssOrFallbackMock.mockResolvedValue([article]);
    getVectorCollectionMock.mockResolvedValue({ add: vectorAddMock } as never);

    await syncSite(siteUrl);

    expect(fetchArticleContentMock).not.toHaveBeenCalled();
    expect(fetchHatenaBookmarksMock).not.toHaveBeenCalled();
    expect(generateArticleSummaryMock).not.toHaveBeenCalled();
    expect(generateHatenaSummaryMock).not.toHaveBeenCalled();
    expect(generateEmbeddingsMock).not.toHaveBeenCalled();
    expect(vectorAddMock).not.toHaveBeenCalled();
    expect(loggerMock.info).not.toHaveBeenCalledWith('記事の同期処理を実行します。', {
      title: article.title,
      url: article.url,
    });

    const savedArticles = await testDb.select().from(articles);
    const savedBookmarks = await testDb.select().from(hatenaBookmarks);

    expect(savedArticles).toHaveLength(1);
    expect(savedArticles[0]).toMatchObject({
      hatenaSummary: '古いはてブ要約',
      id: 'existing-article',
      publishedAt: new Date('2024-01-01T00:00:00.000Z'),
      title: article.title,
      url: article.url,
    });
    expect(savedBookmarks).toHaveLength(1);
    expect(savedBookmarks[0]).toMatchObject({
      articleId: 'existing-article',
      comment: '古いコメント',
      user: 'old',
    });
  });

  it('splits hatena bookmark inserts into chunks of 20', async () => {
    const articleInsertRunMock = vi.fn().mockResolvedValue(undefined);
    const bookmarkInsertRunMock = vi.fn().mockResolvedValue(undefined);
    const bookmarkChunkLengths: number[] = [];
    const bookmarkConflictCalls: number[] = [];
    const insertCallTables: unknown[] = [];

    const insertMock = vi.fn((table: unknown) => {
      const insertIndex = insertCallTables.push(table) - 1;
      const chain = {
        values: vi.fn((values: unknown[]) => {
          if (insertIndex > 0) {
            bookmarkChunkLengths.push(values.length);
          }
          return chain;
        }),
        onConflictDoNothing: vi.fn(() => {
          if (insertIndex > 0) {
            bookmarkConflictCalls.push(1);
          }
          return chain;
        }),
        run: insertIndex > 0 ? bookmarkInsertRunMock : articleInsertRunMock,
      };

      return chain;
    });

    const selectChain = {
      limit: vi.fn().mockResolvedValue([]),
      where: vi.fn().mockReturnThis(),
    };

    const mockedDb = {
      insert: insertMock,
      select: vi.fn(() => ({
        from: vi.fn(() => selectChain),
      })),
    };

    const { syncSite } = await import('./sync.js');
    getDbMock.mockReturnValueOnce(mockedDb as never);

    fetchRssOrFallbackMock.mockResolvedValue([article]);
    fetchArticleContentMock.mockResolvedValue('本文の内容です。');
    fetchHatenaBookmarksMock.mockResolvedValue(
      Array.from({ length: 25 }, (_, index) => ({
        comment: `コメント${index + 1}`,
        user: `user-${index + 1}`,
      })),
    );
    generateArticleSummaryMock.mockResolvedValue('要約文');
    generateHatenaSummaryMock.mockResolvedValue('はてブ要約');
    chunkTextMock.mockReturnValue(['chunk-1']);
    generateEmbeddingsMock.mockResolvedValue([[0.1, 0.2]]);
    getVectorCollectionMock.mockResolvedValue({ add: vi.fn().mockResolvedValue(1) } as never);

    await expect(syncSite(siteUrl)).resolves.toBe(1);

    expect(bookmarkChunkLengths).toEqual([20, 5]);
    expect(bookmarkConflictCalls).toHaveLength(2);
    expect(articleInsertRunMock).toHaveBeenCalledTimes(1);
    expect(bookmarkInsertRunMock).toHaveBeenCalledTimes(2);
  });

  it('stops after processing one new article', async () => {
    const vectorAddMock = vi.fn().mockResolvedValue(1);
    const { syncSite } = await import('./sync.js');

    const limitedArticles = [
      {
        title: '既存の記事',
        pubDate: new Date('2024-01-01T00:00:00.000Z'),
        url: 'https://example.com/articles/0',
      },
      {
        title: '記事1',
        pubDate: new Date('2024-01-02T00:00:00.000Z'),
        url: 'https://example.com/articles/1',
      },
      {
        title: '記事2',
        pubDate: new Date('2024-01-03T00:00:00.000Z'),
        url: 'https://example.com/articles/2',
      },
    ];

    await testDb.insert(articles).values({
      id: 'existing-article',
      siteUrl,
      url: limitedArticles[0]!.url,
      title: limitedArticles[0]!.title,
      content: '本文',
      summary: '既存要約',
      hatenaSummary: '既存はてブ要約',
      publishedAt: limitedArticles[0]!.pubDate,
    });

    fetchRssOrFallbackMock.mockResolvedValue(limitedArticles);
    fetchArticleContentMock.mockImplementation(async (url) => `本文: ${url}`);
    fetchHatenaBookmarksMock.mockResolvedValue([]);
    generateArticleSummaryMock.mockResolvedValue('要約文');
    chunkTextMock.mockReturnValue(['chunk-1']);
    generateEmbeddingsMock.mockResolvedValue([[0.1, 0.2]]);
    getVectorCollectionMock.mockResolvedValue({ add: vectorAddMock } as never);

    await expect(syncSite(siteUrl)).resolves.toBe(1);

    expect(fetchArticleContentMock).toHaveBeenCalledTimes(1);
    expect(generateArticleSummaryMock).toHaveBeenCalledTimes(1);
    expect(vectorAddMock).toHaveBeenCalledTimes(1);
    expect(loggerMock.info).toHaveBeenCalledWith('タイムアウト防止のため、記事の同期を中断して次回に回します。');
    expect(fetchArticleContentMock).not.toHaveBeenCalledWith(limitedArticles[2]!.url);

    const savedArticles = await testDb.select().from(articles);
    expect(savedArticles).toHaveLength(2);
    expect(savedArticles.some((savedArticle) => savedArticle.url === limitedArticles[2]!.url)).toBe(false);
  });

  it('limits subscription sync to two sites per run', async () => {
    const { syncAllSubscriptions } = await import('./sync.js');

    fetchRssOrFallbackMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([article]);
    fetchArticleContentMock.mockResolvedValue('本文の内容です。');
    generateArticleSummaryMock.mockResolvedValue('要約文');
    generateEmbeddingsMock.mockResolvedValue([[0.1, 0.2]]);
    fetchHatenaBookmarksMock.mockResolvedValue([]);
    chunkTextMock.mockReturnValue(['chunk-1']);
    getVectorCollectionMock.mockResolvedValue({ add: vi.fn().mockResolvedValue(1) } as never);

    await testDb.insert(subscriptions).values([
      {
        id: 'subscription-1',
        siteUrl: 'https://example.com/site-1/',
        title: 'site-1',
      },
      {
        id: 'subscription-2',
        siteUrl: 'https://example.com/site-2/',
        title: 'site-2',
      },
      {
        id: 'subscription-3',
        siteUrl: 'https://example.com/site-3/',
        title: 'site-3',
      },
    ]);

    await syncAllSubscriptions();

    expect(fetchRssOrFallbackMock).toHaveBeenCalledTimes(2);
    expect(getVectorCollectionMock).toHaveBeenCalledTimes(2);
    expect(fetchArticleContentMock).toHaveBeenCalledTimes(1);
    expect(generateArticleSummaryMock).toHaveBeenCalledTimes(1);
  });
});
