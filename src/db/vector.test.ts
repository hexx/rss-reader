import { describe, expect, it, vi } from 'vitest';

import { getVectorCollection } from './vector.js';

describe('vector env adapter', () => {
  it('upserts and queries through Vectorize', async () => {
    const upsertMock = vi.fn().mockResolvedValue(undefined);
    const queryMock = vi.fn().mockResolvedValue({
      matches: [{ metadata: { article_id: 'article-1' } }],
    });
    const env = {
      VECTORIZE_INDEX: {
        query: queryMock,
        upsert: upsertMock,
      },
    } as never;

    const collection = await getVectorCollection(env);

    await collection.add([
      {
        article_id: 'article-1',
        text: 'chunk-1',
        vector: [0.1, 0.2],
      },
    ]);

    expect(upsertMock).toHaveBeenCalledWith([
      {
        id: 'article-1:0',
        metadata: {
          article_id: 'article-1',
          text: 'chunk-1',
        },
        values: [0.1, 0.2],
      },
    ]);

    await expect(collection.search([0.1, 0.2]).limit(1).toArray()).resolves.toEqual([
      {
        article_id: 'article-1',
      },
    ]);
    expect(queryMock).toHaveBeenCalledWith([0.1, 0.2], {
      returnMetadata: true,
      returnValues: false,
      topK: 1,
    });
  });

  it('reuses the collection for the same env object', async () => {
    const env = {
      VECTORIZE_INDEX: {
        query: vi.fn(),
        upsert: vi.fn(),
      },
    } as never;

    const first = await getVectorCollection(env);
    const second = await getVectorCollection(env);

    expect(first).toBe(second);
  });
});
