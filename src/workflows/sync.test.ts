import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/scraper.js', () => ({
  getSiteArticles: vi.fn(),
}));

vi.mock('../services/hatena.js', () => ({
  fetchHatenaBookmarks: vi.fn(),
}));

vi.mock('../db/vector.js', () => ({
  getVectorCollection: vi.fn(),
}));

vi.mock('../services/ai.js', async () => {
  const actual = await vi.importActual<typeof import('../services/ai.js')>('../services/ai.js');
  return {
    ...actual,
    generateArticleSummary: vi.fn(),
    generateEmbedding: vi.fn(),
  };
});

import { articles, hatenaBookmarks } from '../db/schema.js';
import { fetchHatenaBookmarks } from '../services/hatena.js';
import { generateArticleSummary, generateEmbedding } from '../services/ai.js';
import { getSiteArticles } from '../services/scraper.js';
import { getVectorCollection } from '../db/vector.js';

const getSiteArticlesMock = vi.mocked(getSiteArticles);
const fetchHatenaBookmarksMock = vi.mocked(fetchHatenaBookmarks);
const generateArticleSummaryMock = vi.mocked(generateArticleSummary);
const generateEmbeddingMock = vi.mocked(generateEmbedding);
const getVectorCollectionMock = vi.mocked(getVectorCollection);

const siteUrl = 'https://example.com/';
const article = {
  content: '本文の内容です。',
  title: '記事タイトル',
  url: 'https://example.com/articles/1',
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

    getSiteArticlesMock.mockReset();
    fetchHatenaBookmarksMock.mockReset();
    generateArticleSummaryMock.mockReset();
    generateEmbeddingMock.mockReset();
    getVectorCollectionMock.mockReset();
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
        title TEXT NOT NULL,
        content TEXT,
        summary TEXT,
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

  it('stores new articles, comments, summaries, and embeddings', async () => {
    const db = await setupDatabase();
    const vectorAddMock = vi.fn().mockResolvedValue(1);
    const { syncSite } = await import('./sync.js');

    getSiteArticlesMock.mockResolvedValue([article]);
    fetchHatenaBookmarksMock.mockResolvedValue(bookmarks);
    generateArticleSummaryMock.mockResolvedValue('要約文');
    generateEmbeddingMock.mockResolvedValue([0.1, 0.2]);
    getVectorCollectionMock.mockResolvedValue({ add: vectorAddMock } as never);

    await syncSite(siteUrl);

    const savedArticles = await db.select().from(articles);
    const savedBookmarks = await db.select().from(hatenaBookmarks);

    expect(savedArticles).toHaveLength(1);
    expect(savedArticles[0]).toMatchObject({
      content: article.content,
      summary: '要約文',
      title: article.title,
      url: article.url,
    });
    expect(savedBookmarks).toHaveLength(1);
    expect(savedBookmarks[0]).toMatchObject({
      comment: '参考になる',
      user: 'alice',
    });
    expect(vectorAddMock).toHaveBeenCalledTimes(2);
    expect(fetchHatenaBookmarksMock).toHaveBeenCalledWith(article.url);
    expect(generateArticleSummaryMock).toHaveBeenCalledWith(article.title, article.content, bookmarks);
    expect(generateEmbeddingMock).toHaveBeenCalledTimes(2);
  });

  it('skips articles that already exist in SQLite', async () => {
    const db = await setupDatabase();
    const vectorAddMock = vi.fn().mockResolvedValue(1);
    const { syncSite } = await import('./sync.js');

    await db.insert(articles).values({
      id: 'existing-article',
      url: article.url,
      title: article.title,
      content: article.content,
      summary: '既存要約',
    });

    getSiteArticlesMock.mockResolvedValue([article]);
    fetchHatenaBookmarksMock.mockResolvedValue(bookmarks);
    generateArticleSummaryMock.mockResolvedValue('要約文');
    generateEmbeddingMock.mockResolvedValue([0.1, 0.2]);
    getVectorCollectionMock.mockResolvedValue({ add: vectorAddMock } as never);

    await syncSite(siteUrl);

    expect(fetchHatenaBookmarksMock).not.toHaveBeenCalled();
    expect(generateArticleSummaryMock).not.toHaveBeenCalled();
    expect(generateEmbeddingMock).not.toHaveBeenCalled();
    expect(vectorAddMock).not.toHaveBeenCalled();
    expect(await db.select().from(articles)).toHaveLength(1);
  });
});
