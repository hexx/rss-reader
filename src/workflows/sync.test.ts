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
    expect(fetchArticleContentMock).toHaveBeenCalledWith(expect.anything(), article.url, {
      jinaApiKey: undefined,
    });
    expect(fetchHatenaBookmarksMock).toHaveBeenCalledWith(expect.anything(), article.url);
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

    expect(fetchHatenaBookmarksMock).toHaveBeenCalledWith(expect.anything(), article.url);
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
    expect(fetchArticleContentMock).toHaveBeenCalledWith(expect.anything(), article.url, {
      jinaApiKey: undefined,
    });
    expect(fetchHatenaBookmarksMock).toHaveBeenCalledWith(expect.anything(), article.url);
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

    expect(fetchHatenaBookmarksMock).toHaveBeenCalledWith(expect.anything(), article.url);
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
    expect(loggerMock.info).toHaveBeenCalledWith('購読されている Source がありません。');
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

    fetchRssOrFallbackMock.mockImplementation(async (_egress: unknown, targetUrl: string) =>
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

    fetchRssOrFallbackMock.mockImplementation(async (_egress: unknown, targetUrl: string) =>
      targetUrl === siteUrl ? [article] : [secondArticle],
    );
    fetchArticleContentMock.mockResolvedValue('本文');
    fetchHatenaBookmarksMock.mockResolvedValue([]);
    generateArticleSummaryMock.mockRejectedValue(new Error('AI unavailable'));

    const { syncAllSubscriptions } = await import('./sync.js');
    await expect(syncAllSubscriptions(false, testEnv)).rejects.toThrow('AI unavailable');

    expect(fetchRssOrFallbackMock).toHaveBeenCalledTimes(2); // パス1で全フィードを取得してから記事処理に入る
    expect(generateArticleSummaryMock).toHaveBeenCalledTimes(1);
    await expect(testDb.select().from(articles)).resolves.toHaveLength(0);
  });
});

describe('二段同期（パス1 のフィード取得優先・律速・補完カーソル）', () => {
  // 律速層は ThrottleError を instanceof で判定し、仮想時計の DI もモジュール状態に
  // 入れるため、同期側と必ず同じモジュール生成から解決する。
  type EgressModule = typeof import('../services/egress.js');
  type TestEgressModule = typeof import('../test-utils/egress.js');

  let egressModule: EgressModule;
  let egress: ReturnType<TestEgressModule['createTestEgressContext']>;
  let resetEgressHooks: TestEgressModule['resetEgressTestHooks'];

  beforeEach(async () => {
    vi.resetModules();
    testDb = (await createTestDatabase()).db;

    egressModule = await import('../services/egress.js');
    const testEgressModule = await import('../test-utils/egress.js');
    testEgressModule.installVirtualEgressTime();
    resetEgressHooks = testEgressModule.resetEgressTestHooks;
    egress = testEgressModule.createTestEgressContext();

    // sync.js は egress.js を静的に import するため、上の生成をそのまま共有する。
    await import('./sync.js');

    fetchHatenaBookmarksMock.mockReset();
    generateArticleSummaryMock.mockReset();
    generateHatenaSummaryMock.mockReset();
    fetchArticleContentMock.mockReset();
    fetchRssOrFallbackMock.mockReset();
    loggerMock.info.mockReset();
    loggerMock.warn.mockReset();
  });

  afterEach(() => {
    resetEgressHooks?.();
  });

  it('パス1で全 Source のフィードを取得してから、パス2で記事処理をする', async () => {
    const order: string[] = [];
    await testDb.insert(subscriptions).values([
      { id: 'subscription-1', siteUrl },
      { id: 'subscription-2', siteUrl: nonHatenaSiteUrl },
    ]);
    fetchRssOrFallbackMock.mockImplementation(async (_egress: unknown, targetUrl: string) => {
      order.push(`feed:${targetUrl}`);
      return targetUrl === siteUrl ? [article] : [secondArticle];
    });
    fetchArticleContentMock.mockImplementation(async () => {
      order.push('content');
      return '本文';
    });
    fetchHatenaBookmarksMock.mockResolvedValue(bookmarks);
    generateArticleSummaryMock.mockResolvedValue('要約文');
    generateHatenaSummaryMock.mockResolvedValue('はてブ要約');

    const { syncAllSubscriptions } = await import('./sync.js');
    await syncAllSubscriptions(false, testEnv, false, { egress });

    expect(order).toEqual([
      `feed:${siteUrl}`,
      `feed:${nonHatenaSiteUrl}`,
      'content',
      'content',
    ]);
  });

  it('429 を受けた Source はパス1末尾で 1 回だけ再試行し、同じ run で取り込む', async () => {
    await testDb.insert(subscriptions).values([{ id: 'subscription-1', siteUrl }]);
    const throttled = () =>
      new egressModule.ThrottleError('Rate limited by hatena: 429 Too Many Requests', {
        bucket: 'hatena',
        nextRetryAtMs: Date.now() + 30 * 60 * 1000,
      });
    fetchRssOrFallbackMock.mockRejectedValueOnce(throttled()).mockResolvedValueOnce([article]);
    fetchArticleContentMock.mockResolvedValue('本文');
    fetchHatenaBookmarksMock.mockResolvedValue(bookmarks);
    generateArticleSummaryMock.mockResolvedValue('要約文');
    generateHatenaSummaryMock.mockResolvedValue('はてブ要約');

    const { syncAllSubscriptions } = await import('./sync.js');
    await syncAllSubscriptions(false, testEnv, false, { egress });

    expect(fetchRssOrFallbackMock).toHaveBeenCalledTimes(2);
    await expect(testDb.select().from(articles)).resolves.toHaveLength(1);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'Source 同期が律速されました。クールダウンを設定したため次周で再試行します。',
      expect.objectContaining({ bucket: 'hatena', nextRetryAt: expect.any(String), siteUrl }),
    );
    // 再試行で成功したので、律速 warn は 1 本だけ。
    expect(loggerMock.warn.mock.calls.filter((call) => String(call[0]).includes('律速'))).toHaveLength(1);
  });

  it('再試行でも取れなければ warn を増やさず、次回以降に譲る', async () => {
    await testDb.insert(subscriptions).values([{ id: 'subscription-1', siteUrl }]);
    fetchRssOrFallbackMock.mockImplementation(async () => {
      throw new egressModule.ThrottleError('Rate limited by hatena: 429 Too Many Requests', {
        bucket: 'hatena',
        nextRetryAtMs: Date.now() + 30 * 60 * 1000,
      });
    });
    fetchArticleContentMock.mockResolvedValue('本文');
    fetchHatenaBookmarksMock.mockResolvedValue([]);
    generateArticleSummaryMock.mockResolvedValue('要約文');

    const { syncAllSubscriptions } = await import('./sync.js');
    await syncAllSubscriptions(false, testEnv, false, { egress });

    expect(fetchRssOrFallbackMock).toHaveBeenCalledTimes(2);
    expect(loggerMock.warn.mock.calls.filter((call) => String(call[0]).includes('律速'))).toHaveLength(1);
    await expect(testDb.select().from(articles)).resolves.toHaveLength(0);
  });

  it('クールダウン中の Source は info でスキップし、他の Source は継続する', async () => {
    const coolingSiteUrl = nonHatenaSiteUrl;
    await testDb.insert(subscriptions).values([
      { id: 'subscription-1', siteUrl },
      { id: 'subscription-2', siteUrl: coolingSiteUrl },
    ]);
    await egressModule.markThrottled(egress, 'example.com', null);

    fetchRssOrFallbackMock.mockImplementation(async (_egress: unknown, targetUrl: string) =>
      targetUrl === siteUrl ? [article] : [secondArticle],
    );
    fetchArticleContentMock.mockResolvedValue('本文');
    fetchHatenaBookmarksMock.mockResolvedValue(bookmarks);
    generateArticleSummaryMock.mockResolvedValue('要約文');
    generateHatenaSummaryMock.mockResolvedValue('はてブ要約');

    const { syncAllSubscriptions } = await import('./sync.js');
    await syncAllSubscriptions(false, testEnv, false, { egress });

    expect(fetchRssOrFallbackMock).toHaveBeenCalledTimes(1);
    expect(fetchRssOrFallbackMock).toHaveBeenCalledWith(expect.anything(), siteUrl);
    expect(loggerMock.info).toHaveBeenCalledWith(
      'Source はクールダウン中のため取得をスキップします。',
      expect.objectContaining({
        bucket: 'example.com',
        nextAllowedAt: expect.any(String),
        siteUrl: coolingSiteUrl,
      }),
    );
    await expect(testDb.select().from(articles)).resolves.toHaveLength(1);
  });

  it('force はクールダウンを無視して取得する（docs/specs/sync-egress-politeness.md）', async () => {
    await testDb.insert(subscriptions).values([{ id: 'subscription-1', siteUrl: nonHatenaSiteUrl }]);
    await egressModule.markThrottled(egress, 'example.com', null);
    fetchRssOrFallbackMock.mockResolvedValue([article]);
    fetchArticleContentMock.mockResolvedValue('本文');
    fetchHatenaBookmarksMock.mockResolvedValue([]);
    generateArticleSummaryMock.mockResolvedValue('要約文');

    const testEgressModule = await import('../test-utils/egress.js');
    const egressForced = testEgressModule.createTestEgressContext({ ignoreCooldown: true });
    const { syncAllSubscriptions } = await import('./sync.js');
    await syncAllSubscriptions(false, testEnv, false, { egress: egressForced, force: true });

    expect(fetchRssOrFallbackMock).toHaveBeenCalledWith(expect.anything(), nonHatenaSiteUrl);
  });

  it('はてブ補完は 1 run 60 件で、カーソルが前回位置から巡回する（ADR-0010）', async () => {
    const many = Array.from({ length: 70 }, (_, index) => ({
      pubDate: new Date('2024-01-02T00:00:00.000Z'),
      title: `記事 ${index}`,
      url: `https://example.com/many/${index}`,
    }));
    await testDb.insert(subscriptions).values([{ id: 'subscription-1', siteUrl }]);
    await testDb.insert(articles).values(
      many.map((item, index) => ({
        content: '本文',
        hatenaSummary: '既存要約',
        id: `article-${index}`,
        isRead: false,
        siteUrl,
        summary: '要約',
        title: item.title,
        url: item.url,
      })),
    );

    fetchRssOrFallbackMock.mockResolvedValue(many);
    fetchHatenaBookmarksMock.mockResolvedValue(bookmarks);
    generateArticleSummaryMock.mockResolvedValue('要約文');
    generateHatenaSummaryMock.mockResolvedValue('はてブ要約');

    const { backfillBudgetPerRun, syncAllSubscriptions } = await import('./sync.js');
    await syncAllSubscriptions(false, testEnv, true, { egress });

    expect(fetchHatenaBookmarksMock).toHaveBeenCalledTimes(backfillBudgetPerRun);
    const firstRunCursor = await testDb
      .select({ backfillCursor: subscriptions.backfillCursor })
      .from(subscriptions);
    expect(firstRunCursor[0]?.backfillCursor).toBe(backfillBudgetPerRun % many.length);

    // 2 周目は前回位置の次から巡回する（先頭からやり直さない）。
    fetchHatenaBookmarksMock.mockClear();
    const visited: string[] = [];
    fetchHatenaBookmarksMock.mockImplementation(async (_egress: unknown, articleUrl: string) => {
      visited.push(articleUrl);
      return bookmarks;
    });
    await syncAllSubscriptions(false, testEnv, true, { egress });

    expect(visited[0]).toBe(many[60]!.url);
    expect(visited).toHaveLength(backfillBudgetPerRun);
    const secondRunCursor = await testDb
      .select({ backfillCursor: subscriptions.backfillCursor })
      .from(subscriptions);
    expect(secondRunCursor[0]?.backfillCursor).toBe((60 + backfillBudgetPerRun) % many.length);
  });

  it('再試行でも枠が空かなければ info で持ち越しを 1 行出す（warn を増やさない）', async () => {
    await testDb.insert(subscriptions).values([{ id: 'subscription-1', siteUrl }]);
    fetchRssOrFallbackMock.mockImplementation(async () => {
      throw new egressModule.EgressUnavailableError('hatena', 'occupied', 0);
    });

    const { syncAllSubscriptions } = await import('./sync.js');
    await syncAllSubscriptions(false, testEnv, false, { egress });

    expect(loggerMock.info).toHaveBeenCalledWith(
      '未取得の Source を次回の同期に持ち越します。',
      expect.objectContaining({ carried: 1, siteUrls: [siteUrl] }),
    );
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it('補完巡回はクールダウンで打ち切り、info 1 本だけ出して warn を増やさない', async () => {
    const items = Array.from({ length: 5 }, (_, index) => ({
      pubDate: new Date('2024-01-02T00:00:00.000Z'),
      title: `記事 ${index}`,
      url: `https://example.com/cool/${index}`,
    }));
    await testDb.insert(subscriptions).values([{ id: 'subscription-1', siteUrl }]);
    await testDb.insert(articles).values(
      items.map((item, index) => ({
        content: '本文',
        hatenaSummary: null,
        id: `cool-${index}`,
        isRead: false,
        siteUrl,
        summary: '要約',
        title: item.title,
        url: item.url,
      })),
    );

    fetchRssOrFallbackMock.mockResolvedValue(items);
    fetchHatenaBookmarksMock.mockImplementation(async () => {
      throw new egressModule.EgressUnavailableError('hatena', 'cooldown', Date.now() + 30 * 60 * 1000);
    });
    generateArticleSummaryMock.mockResolvedValue('要約文');
    generateHatenaSummaryMock.mockResolvedValue('はてブ要約');

    const { syncAllSubscriptions } = await import('./sync.js');
    await syncAllSubscriptions(false, testEnv, true, { egress });

    // 1 件目で枠が空かないと分かれば、残りは試みない（=warn/info の乱発がない）。
    expect(fetchHatenaBookmarksMock).toHaveBeenCalledTimes(1);
    expect(loggerMock.warn).not.toHaveBeenCalled();
    expect(loggerMock.info).toHaveBeenCalledWith(
      'はてブ補完は取得枠のクールダウン中のため、この Source を打ち切ります。',
      expect.objectContaining({ bucket: 'hatena', nextRetryAt: expect.any(String), siteUrl }),
    );
    const cursor = await testDb.select({ backfillCursor: subscriptions.backfillCursor }).from(subscriptions);
    expect(cursor[0]?.backfillCursor).toBe(1);
  });

  it('新着記事のはてブがクールダウン中なら info でコメントなし保存する', async () => {
    await testDb.insert(subscriptions).values([{ id: 'subscription-1', siteUrl }]);
    fetchRssOrFallbackMock.mockResolvedValue([article]);
    fetchArticleContentMock.mockResolvedValue('本文');
    fetchHatenaBookmarksMock.mockRejectedValue(
      new egressModule.EgressUnavailableError('hatena', 'cooldown', Date.now() + 30 * 60 * 1000),
    );
    generateArticleSummaryMock.mockResolvedValue('要約文');

    const { syncAllSubscriptions } = await import('./sync.js');
    await syncAllSubscriptions(false, testEnv, false, { egress });

    await expect(testDb.select().from(articles)).resolves.toHaveLength(1);
    expect(loggerMock.info).toHaveBeenCalledWith(
      'はてなブックマークはクールダウン中のため、コメントなしで保存します。',
      expect.objectContaining({ articleUrl: article.url, bucket: 'hatena', nextRetryAt: expect.any(String) }),
    );
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it('run 完了サマリを 1 本出す', async () => {
    await testDb.insert(subscriptions).values([{ id: 'subscription-1', siteUrl }]);
    fetchRssOrFallbackMock.mockResolvedValue([article]);
    fetchArticleContentMock.mockResolvedValue('本文');
    fetchHatenaBookmarksMock.mockResolvedValue(bookmarks);
    generateArticleSummaryMock.mockResolvedValue('要約文');
    generateHatenaSummaryMock.mockResolvedValue('はてブ要約');

    const { syncAllSubscriptions } = await import('./sync.js');
    await syncAllSubscriptions(false, testEnv, false, { egress });

    expect(loggerMock.info).toHaveBeenCalledWith(
      '同期が完了しました。',
      expect.objectContaining({ skipped: 0, sources: 1, synced: 1, throttled: 0 }),
    );
  });
});
