import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { articles } from '../db/schema.js';
import { getVectorCollection } from '../db/vector.js';
import { generateEmbedding } from '../services/ai.js';

const getVectorCollectionMock = vi.mocked(getVectorCollection);
const generateEmbeddingMock = vi.mocked(generateEmbedding);

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
  `);

  return db;
}

describe('searchArticles', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('DATABASE_URL', ':memory:');
    vi.stubEnv('OPENCODE_GO_BASE_URL', 'https://opencode.example/v1');
    vi.stubEnv('OPENCODE_GO_API_KEY', 'test-api-key');
    getVectorCollectionMock.mockReset();
    generateEmbeddingMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('hydrates article search results from LanceDB matches', async () => {
    const db = await setupDatabase();
    await db.insert(articles).values({
      id: 'article-1',
      url: 'https://example.com/articles/1',
      title: '記事タイトル',
      content: '本文',
      summary: '要約文',
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
        id: 'article-1',
        summary: '要約文',
        title: '記事タイトル',
        url: 'https://example.com/articles/1',
      },
    ]);

    expect(generateEmbeddingMock).toHaveBeenCalledWith('検索語');
  });
});
