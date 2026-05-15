import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@lancedb/lancedb', () => ({
  connect: vi.fn(),
}));

import { connect } from '@lancedb/lancedb';

import { getVectorCollection, getVectorDatabasePath, getVectorDimension } from './vector.js';

const connectMock = vi.mocked(connect);

describe('vector env adapter', () => {
  beforeEach(() => {
    connectMock.mockReset();
  });

  it('resolves LanceDB path and vector dimension from env bindings', () => {
    expect(getVectorDatabasePath({ VECTOR_DB_PATH: '/tmp/lancedb' })).toBe('/tmp/lancedb');
    expect(getVectorDatabasePath({})).toBe('./lancedb');
    expect(getVectorDimension({ VECTOR_DIMENSION: '4' })).toBe(4);
    expect(getVectorDimension({})).toBe(1536);
  });

  it('connects LanceDB with the provided env bindings', async () => {
    const deleteMock = vi.fn().mockResolvedValue(undefined);
    const createTableMock = vi.fn().mockResolvedValue({ delete: deleteMock });
    const tableNamesMock = vi.fn().mockResolvedValue([]);

    connectMock.mockResolvedValue({
      createTable: createTableMock,
      openTable: vi.fn(),
      tableNames: tableNamesMock,
    } as never);

    await getVectorCollection({
      VECTOR_DB_PATH: '/tmp/lancedb',
      VECTOR_DIMENSION: '4',
    });

    expect(connectMock).toHaveBeenCalledWith('/tmp/lancedb');
    expect(createTableMock).toHaveBeenCalledWith({
      name: 'article_chunks',
      data: [
        {
          article_id: '__placeholder__',
          text: '',
          vector: [0, 0, 0, 0],
        },
      ],
    });
    expect(deleteMock).toHaveBeenCalledWith("article_id = '__placeholder__'");
  });
});
