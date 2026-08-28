import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeEnv } from '../env.js';
import { articles, hatenaBookmarks, subscriptions } from '../db/schema.js';
import { createTestDatabase } from '../test-utils/sqljs-db.js';

const testEnv: RuntimeEnv = {
  AI_API: 'openai-responses',
  AI_API_KEY: 'test-api-key',
  AI_BASE_URL: 'https://api.openai.com/v1',
  AI_MODEL: 'gpt-5.6-luna',
  AI_REASONING_EFFORT: 'medium',
};

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
  pubDate: new Date('2024-01-01T00:00:00.000Z'),
  title: '記事タイトル',
  url: 'https://example.com/articles/1',
};

const secondArticle = {
  pubDate: new Date('2024-01-02T00:00:00.000Z'),
  title: '記事タイトル2',
  url: 'https://example.com/articles/2',
};

const thirdArticle = {
  pubDate: new Date('2024-01-03T00:00:00.000Z'),
  title: '記事タイトル3',
  url: 'https://example.com/articles/3',
};

const bookmarks = [
  {
    comment: '参考になる',
    timestamp: new Date('2024-01-01T00:00:00.000Z'),
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

    await expect(syncSite(siteUrl, false, testEnv)).resolves.toBe(1);

    const savedArticles = await testDb.select().from(articles);
    const savedBookmarks = await testDb.select().from(hatenaBookmarks);

    expect(savedArticles).toHaveLength(1);
    expect(savedArticles[0]).toMatchObject({
      content: '',
      hatenaSummary: 'はてブ要約',
      isRead: false,
      publishedAt: new Date('2024-01-01T00:00:00.000Z'),
      siteUrl,
      summary: '要約文',
      title: article.title,
      url: article.url,
    });
    expect(savedBookmarks).toHaveLength(1);
    expect(savedBookmarks[0]).toMatchObject({
      comment: '参考になる',
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
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

  it('attempts to fetch Hatena bookmarks for any subscription site (rate-limiter is the guard)', async () => {
    const { syncSite } = await import('./sync.js');

    fetchRssOrFallbackMock.mockResolvedValue([article]);
    fetchArticleContentMock.mockResolvedValue('本文の内容です。');
    generateArticleSummaryMock.mockResolvedValue('要約文');
    // 非 Hatena サイトでも、jsonlite は記事 URL をキーにしてブックマークを返す
    // 可能性があるため、常に取得を試みる。返ってきた結果が空でも問題なし。
    fetchHatenaBookmarksMock.mockResolvedValue([]);

    await syncSite(nonHatenaSiteUrl, false, testEnv);

    expect(fetchHatenaBookmarksMock).toHaveBeenCalledWith(article.url);
    // ブックマークが 0 件なので、generateHatenaSummary は呼ばれない
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

  it('keeps the article when bookmark fetch is rate-limited (backfill later)', async () => {
    const { syncSite } = await import('./sync.js');

    fetchRssOrFallbackMock.mockResolvedValue([article]);
    fetchArticleContentMock.mockResolvedValue('本文');
    // 1 回目: 失敗 (429) → レートリミッターが backoff を更新し、
    // 記事自体はコメントなしで保存される（次のフル同期でバックフィルされる）。
    fetchHatenaBookmarksMock.mockRejectedValueOnce(new Error('Hatena rate limited: 429 Too Many Requests'));
    generateArticleSummaryMock.mockResolvedValue('要約文');

    await syncSite(siteUrl, false, testEnv);
    // 本文・要約は成功しているので、記事はコメントなしで保存される
    const savedArticles = await testDb.select().from(articles);
    expect(savedArticles).toHaveLength(1);
    expect(savedArticles[0]).toMatchObject({
      content: '本文',
      hatenaSummary: null,
      summary: '要約文',
    });
    // ブックマークは保存されない
    const savedBookmarks = await testDb.select().from(hatenaBookmarks);
    expect(savedBookmarks).toHaveLength(0);
  });

  it('regenerates the missing hatena summary during bookmark backfill', async () => {
    const { syncSite } = await import('./sync.js');

    fetchRssOrFallbackMock.mockResolvedValue([article]);
    fetchArticleContentMock.mockResolvedValue('本文');
    generateArticleSummaryMock.mockResolvedValue('要約文');
    // 1 回目: ブクマ取得失敗 → hatenaSummary は null のまま保存
    fetchHatenaBookmarksMock.mockRejectedValueOnce(new Error('Hatena rate limited: 429 Too Many Requests'));
    generateHatenaSummaryMock.mockResolvedValue('はてブ要約');

    await syncSite(siteUrl, false, testEnv);
    let savedArticles = await testDb.select().from(articles);
    expect(savedArticles).toHaveLength(1);
    expect(savedArticles[0]?.hatenaSummary).toBeNull();

    // 2 回目 (フル同期 = バックフィル有効): ブクマ取得成功 → 要約も再生成される
    fetchHatenaBookmarksMock.mockResolvedValue(bookmarks);
    await syncSite(siteUrl, false, testEnv);

    savedArticles = await testDb.select().from(articles);
    expect(savedArticles).toHaveLength(1);
    expect(savedArticles[0]?.hatenaSummary).toBe('はてブ要約');
    // バックフィルでは記事要約は再生成しない
    expect(generateArticleSummaryMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to empty content when article fetch fails', async () => {
    const { syncSite } = await import('./sync.js');

    fetchRssOrFallbackMock.mockResolvedValue([article]);
    fetchArticleContentMock.mockRejectedValueOnce(new Error('scrape failed'));
    fetchHatenaBookmarksMock.mockResolvedValue([
      { comment: '面白い', timestamp: new Date('2024-01-05T00:00:00.000Z'), user: 'bob' },
    ]);
    generateArticleSummaryMock.mockResolvedValue('要約文');
    generateHatenaSummaryMock.mockResolvedValue('反応の要約');

    await expect(syncSite(siteUrl, false, testEnv)).resolves.toBe(1);

    const savedArticles = await testDb.select().from(articles);
    expect(savedArticles).toHaveLength(1);
    expect(savedArticles[0]).toMatchObject({
      content: '',
      hatenaSummary: '反応の要約',
      siteUrl,
      summary: '要約文',
      title: article.title,
      url: article.url,
    });
    expect(fetchArticleContentMock).toHaveBeenCalledWith(article.url);
    expect(fetchHatenaBookmarksMock).toHaveBeenCalledWith(article.url);
    expect(generateArticleSummaryMock).toHaveBeenCalledWith(article.title, '', expect.any(Object));
    expect(generateHatenaSummaryMock).toHaveBeenCalledWith(
      [{ comment: '面白い', timestamp: new Date('2024-01-05T00:00:00.000Z'), user: 'bob' }],
      expect.any(Object),
    );
    expect(loggerMock.warn).toHaveBeenCalledWith(
      '本文の取得に失敗したため、本文なしで処理を継続します。',
      expect.objectContaining({
        articleUrl: article.url,
        error: 'scrape failed',
        siteUrl,
        title: article.title,
      }),
    );
  });

  it('fails fast when an article summary generation fails', async () => {
    const { syncSite } = await import('./sync.js');

    fetchRssOrFallbackMock.mockResolvedValue([article]);
    fetchArticleContentMock.mockResolvedValue('本文の内容です。');
    generateArticleSummaryMock.mockRejectedValue(new Error('summary failed'));

    await expect(syncSite(siteUrl, true, testEnv)).rejects.toThrow('summary failed');

    expect(fetchHatenaBookmarksMock).toHaveBeenCalledWith(article.url);
    expect(generateHatenaSummaryMock).not.toHaveBeenCalled();
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it('stops subsequent articles when an article summary fails in non-debug mode', async () => {
    const { syncSite } = await import('./sync.js');

    fetchRssOrFallbackMock.mockResolvedValue([article, secondArticle]);
    fetchArticleContentMock.mockResolvedValue('本文');
    fetchHatenaBookmarksMock.mockResolvedValue(bookmarks);
    generateArticleSummaryMock.mockRejectedValueOnce(new Error('first failed'));

    await expect(syncSite(siteUrl, false, testEnv)).rejects.toThrow('first failed');

    const savedArticles = await testDb.select().from(articles);
    expect(savedArticles).toHaveLength(0);
    expect(generateArticleSummaryMock).toHaveBeenCalledTimes(1);
  });

  it('does not re-insert articles that already exist', async () => {
    const { syncSite } = await import('./sync.js');

    fetchRssOrFallbackMock.mockResolvedValue([article]);
    fetchArticleContentMock.mockResolvedValue('本文');
    fetchHatenaBookmarksMock.mockResolvedValue(bookmarks);
    generateArticleSummaryMock.mockResolvedValue('要約文');
    generateHatenaSummaryMock.mockResolvedValue('はてブ要約');

    await syncSite(siteUrl, false, testEnv);
    await syncSite(siteUrl, false, testEnv);

    const savedArticles = await testDb.select().from(articles);
    expect(savedArticles).toHaveLength(1);
    expect(generateArticleSummaryMock).toHaveBeenCalledTimes(1);
  });

  it('re-fetches bookmarks for existing articles and does not duplicate rows', async () => {
    const { syncSite } = await import('./sync.js');

    fetchRssOrFallbackMock.mockResolvedValue([article]);
    fetchArticleContentMock.mockResolvedValue('本文');
    // 1 回目: alice のみ、2 回目: alice + bob（jsonlite の上限超過で取りこぼされていた分を補完する想定）
    fetchHatenaBookmarksMock
      .mockResolvedValueOnce([bookmarks[0]!])
      .mockResolvedValueOnce([
        bookmarks[0]!,
        { comment: '後から取れた', timestamp: new Date('2024-01-04T00:00:00.000Z'), user: 'bob' },
      ]);
    generateArticleSummaryMock.mockResolvedValue('要約文');
    generateHatenaSummaryMock.mockResolvedValue('はてブ要約');

    await syncSite(siteUrl, false, testEnv);
    await syncSite(siteUrl, false, testEnv);

    const savedArticles = await testDb.select().from(articles);
    // 記事は 1 件のまま変わらない
    expect(savedArticles).toHaveLength(1);

    const savedBookmarks = await testDb.select().from(hatenaBookmarks);
    // Alice は UNIQUE 制約で重複せず、bob が増えて 2 行になる
    expect(savedBookmarks).toHaveLength(2);
    expect(savedBookmarks.map((row) => row.user).toSorted()).toEqual(['alice', 'bob']);
    // Bob のコメントは 2 回目で取得したものがそのまま保存される
    const bobRow = savedBookmarks.find((row) => row.user === 'bob');
    expect(bobRow).toMatchObject({
      comment: '後から取れた',
      createdAt: new Date('2024-01-04T00:00:00.000Z'),
    });
  });

  it('refreshes createdAt and comment of existing bookmarks on re-fetch (DO UPDATE self-healing)', async () => {
    const { syncSite } = await import('./sync.js');

    fetchRssOrFallbackMock.mockResolvedValue([article]);
    fetchArticleContentMock.mockResolvedValue('本文');
    // 1 回目: 壊れた古い createdAt と旧コメント、2 回目: 正しい最新値（自然治癒の想定）
    fetchHatenaBookmarksMock
      .mockResolvedValueOnce([
        { comment: '古いコメント', timestamp: new Date('1970-01-01T00:33:45.000Z'), user: 'alice' },
      ])
      .mockResolvedValueOnce([
        { comment: '編集後のコメント', timestamp: new Date('2024-01-05T00:00:00.000Z'), user: 'alice' },
      ]);
    generateArticleSummaryMock.mockResolvedValue('要約文');
    generateHatenaSummaryMock.mockResolvedValue('はてブ要約');

    await syncSite(siteUrl, false, testEnv);
    await syncSite(siteUrl, false, testEnv);

    const savedBookmarks = await testDb.select().from(hatenaBookmarks);
    // 行は増えず、既存行が最新化される
    expect(savedBookmarks).toHaveLength(1);
    expect(savedBookmarks[0]).toMatchObject({
      comment: '編集後のコメント',
      createdAt: new Date('2024-01-05T00:00:00.000Z'),
      user: 'alice',
    });
  });

  it('skips bookmark backfill for existing articles when includeBookmarkBackfill is false', async () => {
    const { syncSite } = await import('./sync.js');

    fetchRssOrFallbackMock.mockResolvedValue([article]);
    fetchArticleContentMock.mockResolvedValue('本文');
    fetchHatenaBookmarksMock.mockResolvedValue(bookmarks);
    generateArticleSummaryMock.mockResolvedValue('要約文');
    generateHatenaSummaryMock.mockResolvedValue('はてブ要約');

    // 1 回目: 新着記事として取り込まれる（バックフィル flag に関係なく初回ブクマは取得される）
    await expect(syncSite(siteUrl, false, testEnv, false)).resolves.toBe(1);
    fetchHatenaBookmarksMock.mockClear();

    // 2 回目: 既存記事。includeBookmarkBackfill=false なのでブクマ再取得は行われない
    await expect(syncSite(siteUrl, false, testEnv, false)).resolves.toBe(0);
    expect(fetchHatenaBookmarksMock).not.toHaveBeenCalled();

    const savedArticles = await testDb.select().from(articles);
    expect(savedArticles).toHaveLength(1);
  });

  it('processes all new articles without a per-run cap', async () => {
    const { syncSite } = await import('./sync.js');

    fetchRssOrFallbackMock.mockResolvedValue([article, secondArticle, thirdArticle]);
    fetchArticleContentMock.mockResolvedValue('本文');
    fetchHatenaBookmarksMock.mockResolvedValue(bookmarks);
    generateArticleSummaryMock.mockResolvedValue('要約文');
    generateHatenaSummaryMock.mockResolvedValue('はてブ要約');

    await expect(syncSite(siteUrl, false, testEnv)).resolves.toBe(3);

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

    await syncAllSubscriptions(false, testEnv);

    expect(fetchRssOrFallbackMock).not.toHaveBeenCalled();
    expect(loggerMock.info).toHaveBeenCalledWith('購読サイトがありません。');
  });

  it('splits hatena bookmark inserts into chunks of 20', async () => {
    const manyBookmarks = Array.from({ length: 25 }, (_, index) => ({
      comment: `comment-${index}`,
      timestamp: new Date(`2024-01-01T00:00:${String(index).padStart(2, '0')}.000Z`),
      user: `user-${index}`,
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
    await syncAllSubscriptions(false, testEnv);

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
    await syncAllSubscriptions(false, testEnv);

    const savedArticles = await testDb.select().from(articles);
    expect(savedArticles).toHaveLength(2);
    expect(savedArticles.map((row) => row.title).toSorted()).toEqual([article.title, secondArticle.title].toSorted());
  });

  it('stops all subscribed sites when AI generation fails', async () => {
    await testDb.insert(subscriptions).values([
      { id: 'subscription-1', siteUrl },
      { id: 'subscription-2', siteUrl: nonHatenaSiteUrl },
    ]);

    fetchRssOrFallbackMock.mockImplementation(async (targetUrl) =>
      targetUrl === siteUrl ? [article] : [secondArticle],
    );
    fetchArticleContentMock.mockResolvedValue('本文');
    fetchHatenaBookmarksMock.mockResolvedValue([]);
    generateArticleSummaryMock.mockRejectedValue(new Error('AI unavailable'));

    const { syncAllSubscriptions } = await import('./sync.js');
    await expect(syncAllSubscriptions(false, testEnv)).rejects.toThrow('AI unavailable');

    expect(fetchRssOrFallbackMock).toHaveBeenCalledTimes(1);
    expect(generateArticleSummaryMock).toHaveBeenCalledTimes(1);
    await expect(testDb.select().from(articles)).resolves.toHaveLength(0);
  });
});
