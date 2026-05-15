import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { articles, hatenaBookmarks } from '../db/schema.js';
import { createTestDatabase } from '../test-utils/sqljs-db.js';

let testDb: Awaited<ReturnType<typeof createTestDatabase>>['db'];

const { getDbMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(() => testDb),
}));

vi.mock('../db/index.js', () => ({
  getDb: getDbMock,
}));

vi.mock('../db/vector.js', () => ({
  getVectorCollection: vi.fn(),
}));

vi.mock('../services/ai.js', async () => {
  const actual = await vi.importActual<typeof import('../services/ai.js')>('../services/ai.js');
  return {
    ...actual,
    generateEmbedding: vi.fn(),
  };
});

import { getVectorCollection } from '../db/vector.js';
import { generateEmbedding } from '../services/ai.js';

const getVectorCollectionMock = vi.mocked(getVectorCollection);
const generateEmbeddingMock = vi.mocked(generateEmbedding);

describe('searchArticles', () => {
  beforeEach(async () => {
    vi.resetModules();
    testDb = (await createTestDatabase()).db;
    vi.stubEnv('OPENCODE_GO_BASE_URL', 'https://opencode.example/v1');
    vi.stubEnv('OPENCODE_GO_API_KEY', 'test-api-key');
    getVectorCollectionMock.mockReset();
    generateEmbeddingMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('hydrates article search results from Vectorize matches', async () => {
    await testDb.insert(articles).values({
      id: 'article-1',
      siteUrl: 'https://example.com/',
      url: 'https://example.com/articles/1',
      title: '記事タイトル',
      content: '本文',
      summary: '要約文',
      hatenaSummary: '反応の要約',
      isRead: false,
      createdAt: new Date(0),
    });

    await testDb.insert(hatenaBookmarks).values({
      id: 'bookmark-1',
      articleId: 'article-1',
      user: 'alice',
      comment: '参考になる',
      createdAt: new Date(0),
    });

    generateEmbeddingMock.mockResolvedValue([0.1, 0.2]);
    getVectorCollectionMock.mockResolvedValue({
      search: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([{ article_id: 'article-1' }]),
        }),
      }),
    } as never);

    const { searchArticles } = await import('./search.js');

    await expect(searchArticles('検索語')).resolves.toEqual([
      {
        bookmarks: [
          {
            comment: '参考になる',
            createdAt: '1970-01-01T00:00:00.000Z',
            id: 'bookmark-1',
            user: 'alice',
          },
        ],
        createdAt: '1970-01-01T00:00:00.000Z',
        id: 'article-1',
        hatenaSummary: '反応の要約',
        isRead: false,
        siteUrl: 'https://example.com/',
        summary: '要約文',
        title: '記事タイトル',
        url: 'https://example.com/articles/1',
      },
    ]);

    expect(generateEmbeddingMock).toHaveBeenCalledWith('検索語', expect.any(Object));
  });
});
