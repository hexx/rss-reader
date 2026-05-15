import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('../utils/chunking.js', () => ({
  chunkText: vi.fn(),
}));

vi.mock('../utils/sleep.js', () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
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

import { articles, hatenaBookmarks } from '../db/schema.js';
import { fetchHatenaBookmarks } from '../services/hatena.js';
import { generateArticleSummary, generateEmbeddings, generateHatenaSummary } from '../services/ai.js';
import { fetchArticleContent, fetchRssOrFallback } from '../services/scraper.js';
import { getVectorCollection } from '../db/vector.js';
import { chunkText } from '../utils/chunking.js';
import { sleep } from '../utils/sleep.js';
import { logger } from '../utils/logger.js';

const fetchHatenaBookmarksMock = vi.mocked(fetchHatenaBookmarks);
const generateArticleSummaryMock = vi.mocked(generateArticleSummary);
const generateEmbeddingsMock = vi.mocked(generateEmbeddings);
const generateHatenaSummaryMock = vi.mocked(generateHatenaSummary);
const fetchArticleContentMock = vi.mocked(fetchArticleContent);
const fetchRssOrFallbackMock = vi.mocked(fetchRssOrFallback);
const getVectorCollectionMock = vi.mocked(getVectorCollection);
const chunkTextMock = vi.mocked(chunkText);
const sleepMock = vi.mocked(sleep);
const loggerMock = vi.mocked(logger);

const siteUrl = 'https://b.hatena.ne.jp/entry/example.com/';
const nonHatenaSiteUrl = 'https://example.com/';
const article = {
  title: '記事タイトル',
  pubDate: new Date('2024-01-01T00:00:00.000Z'),
  url: 'https://example.com/articles/1',
};

const nextArticle = {
  title: '次の記事',
  pubDate: new Date('2024-01-02T00:00:00.000Z'),
  url: 'https://example.com/articles/2',
};

const bookmarks = [
  {
    comment: '参考になる',
    user: 'alice',
  },
];

describe('syncSite', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('DATABASE_URL', ':memory:');
    vi.stubEnv('OPENCODE_GO_BASE_URL', 'https://opencode.example/v1');
    vi.stubEnv('OPENCODE_GO_API_KEY', 'test-api-key');
    vi.stubEnv('OPENCODE_GO_MODEL', 'test-model');

    fetchHatenaBookmarksMock.mockReset();
    generateArticleSummaryMock.mockReset();
    generateEmbeddingsMock.mockReset();
    generateHatenaSummaryMock.mockReset();
    fetchArticleContentMock.mockReset();
    fetchRssOrFallbackMock.mockReset();
    getVectorCollectionMock.mockReset();
    chunkTextMock.mockReset();
    sleepMock.mockReset();
    loggerMock.info.mockReset();
    loggerMock.warn.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function setupDatabase() {
    const { sqlite, db } = await import('../db/index.js');

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
        created_at INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE
      );
    `);

    return db;
  }

  it('stores new articles, comments, summaries, and embeddings even when content is empty', async () => {
    const db = await setupDatabase();
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

    await syncSite(siteUrl);

    const savedArticles = await db.select().from(articles);
    const savedBookmarks = await db.select().from(hatenaBookmarks);

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
    expect(loggerMock.info).toHaveBeenCalledWith('記事の同期処理を実行します。', {
      title: article.title,
      url: article.url,
    });
  });

  it('skips Hatena bookmarks for non-Hatena sites', async () => {
    const db = await setupDatabase();
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

    const savedArticles = await db.select().from(articles);
    const savedBookmarks = await db.select().from(hatenaBookmarks);

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

  it('continues processing later articles when one article fails', async () => {
    const db = await setupDatabase();
    const vectorAddMock = vi.fn().mockResolvedValue(1);
    const { syncSite } = await import('./sync.js');

    fetchRssOrFallbackMock.mockResolvedValue([article, nextArticle]);
    fetchArticleContentMock.mockRejectedValueOnce(new Error('scrape failed'));
    fetchArticleContentMock.mockResolvedValueOnce('次の記事本文');
    fetchHatenaBookmarksMock.mockResolvedValue([{ user: 'bob', comment: '面白い' }]);
    generateArticleSummaryMock.mockResolvedValue('次の記事の要約');
    generateHatenaSummaryMock.mockResolvedValue('反応の要約');
    chunkTextMock.mockReturnValue(['chunk-1', 'chunk-2']);
    generateEmbeddingsMock.mockResolvedValue([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    getVectorCollectionMock.mockResolvedValue({ add: vectorAddMock } as never);

    await syncSite(siteUrl);

    const savedArticles = await db.select().from(articles);
    expect(savedArticles).toHaveLength(1);
    expect(savedArticles[0]).toMatchObject({
      content: '次の記事本文',
      hatenaSummary: '反応の要約',
      summary: '次の記事の要約',
      siteUrl,
      title: nextArticle.title,
      url: nextArticle.url,
    });
    expect(fetchHatenaBookmarksMock).toHaveBeenCalledTimes(1);
    expect(generateArticleSummaryMock).toHaveBeenCalledTimes(1);
    expect(generateHatenaSummaryMock).toHaveBeenCalledTimes(1);
    expect(generateEmbeddingsMock).toHaveBeenCalledTimes(1);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      '記事の同期に失敗しました。',
      expect.objectContaining({
        articleUrl: article.url,
        siteUrl,
        title: article.title,
        error: 'scrape failed',
      }),
    );
  });

  it('fails fast in debug mode when an article sync fails', async () => {
    const db = await setupDatabase();
    const vectorAddMock = vi.fn().mockResolvedValue(1);
    const { syncSite } = await import('./sync.js');
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    fetchRssOrFallbackMock.mockResolvedValue([article]);
    fetchArticleContentMock.mockRejectedValue(new Error('scrape failed'));
    getVectorCollectionMock.mockResolvedValue({ add: vectorAddMock } as never);

    await expect(syncSite(siteUrl, true)).rejects.toThrow('scrape failed');

    expect(fetchHatenaBookmarksMock).not.toHaveBeenCalled();
    expect(generateArticleSummaryMock).not.toHaveBeenCalled();
    expect(generateHatenaSummaryMock).not.toHaveBeenCalled();
    expect(generateEmbeddingsMock).not.toHaveBeenCalled();
    expect(vectorAddMock).not.toHaveBeenCalled();
    expect(loggerMock.warn).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('scrape failed'));

    consoleErrorSpy.mockRestore();
    expect(await db.select().from(articles)).toHaveLength(0);
  });

  it('skips existing articles without refreshing Hatena data', async () => {
    const db = await setupDatabase();
    const vectorAddMock = vi.fn().mockResolvedValue(1);
    const { syncSite } = await import('./sync.js');

    await db.insert(articles).values({
      id: 'existing-article',
      siteUrl,
      url: article.url,
      title: article.title,
      content: '本文',
      summary: '既存要約',
      hatenaSummary: '古いはてブ要約',
      publishedAt: new Date('2024-01-01T00:00:00.000Z'),
    });

    await db.insert(hatenaBookmarks).values({
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

    const savedArticles = await db.select().from(articles);
    const savedBookmarks = await db.select().from(hatenaBookmarks);

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
});
