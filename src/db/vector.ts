import 'dotenv/config';

import * as lancedb from '@lancedb/lancedb';
import type { VectorizeIndex } from '@cloudflare/workers-types';

import type { RuntimeEnv } from '../env.js';

export interface VectorCollectionRow {
  article_id: string;
  text: string;
  vector: number[];
}

export interface VectorCollectionHit {
  article_id?: string;
}

export interface VectorCollection {
  add(rows: VectorCollectionRow[]): Promise<unknown>;
  search(vector: number[]): {
    limit(limit: number): {
      toArray(): Promise<VectorCollectionHit[]>;
    };
  };
}

type VectorEnv = RuntimeEnv & {
  VECTORIZE_INDEX?: VectorizeIndex;
};

export function getVectorDatabasePath(env: RuntimeEnv = process.env): string {
  return env.VECTOR_DB_PATH?.trim() || './lancedb';
}

export const vectorCollectionName = 'article_chunks';
export const defaultVectorDimension = 1536;

const vectorCollectionCache = new WeakMap<object, Promise<VectorCollection>>();

export function getVectorDimension(env: RuntimeEnv = process.env): number {
  const rawValue = env.VECTOR_DIMENSION;

  if (rawValue === undefined || rawValue.trim() === '') {
    return defaultVectorDimension;
  }

  const dimension = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(dimension) || dimension <= 0) {
    throw new RangeError('VECTOR_DIMENSION must be a positive integer');
  }

  return dimension;
}

function createPlaceholderRow(env: RuntimeEnv): VectorCollectionRow {
  const vectorDimension = getVectorDimension(env);

  return {
    article_id: '__placeholder__',
    text: '',
    vector: Array.from({ length: vectorDimension }, () => 0),
  };
}

function createVectorizeCollection(index: VectorizeIndex): VectorCollection {
  return {
    async add(rows: VectorCollectionRow[]): Promise<unknown> {
      if (rows.length === 0) {
        return undefined;
      }

      await index.upsert(
        rows.map((row, rowIndex) => ({
          id: `${row.article_id}:${rowIndex}`,
          metadata: {
            article_id: row.article_id,
            text: row.text,
          },
          values: row.vector,
        })),
      );

      return undefined;
    },
    search(vector: number[]) {
      return {
        limit(limit: number) {
          return {
            async toArray(): Promise<VectorCollectionHit[]> {
              const result = await index.query(vector, {
                returnMetadata: true,
                returnValues: false,
                topK: limit,
              });

              return result.matches.map((match) => ({
                ...(match.metadata !== undefined && typeof match.metadata.article_id === 'string'
                  ? { article_id: match.metadata.article_id }
                  : {}),
              }));
            },
          };
        },
      };
    },
  };
}

function createLanceCollection(env: RuntimeEnv): Promise<VectorCollection> {
  return (async () => {
    const database = await lancedb.connect(getVectorDatabasePath(env));
    const tableNames = await database.tableNames();

    if (tableNames.includes(vectorCollectionName)) {
      return database.openTable(vectorCollectionName) as unknown as VectorCollection;
    }

    const table = await database.createTable({
      name: vectorCollectionName,
      data: [createPlaceholderRow(env) as unknown as Record<string, unknown>],
    });

    await table.delete("article_id = '__placeholder__'");

    return table as unknown as VectorCollection;
  })();
}

export function getVectorCollection(env: VectorEnv = process.env): Promise<VectorCollection> {
  if (env === process.env) {
    return vectorCollectionCache.get(env as object) ?? (vectorCollectionCache.set(env as object, createLanceCollection(env)), vectorCollectionCache.get(env as object)!);
  }

  const cacheKey = env as object;
  const cachedCollection = vectorCollectionCache.get(cacheKey);
  if (cachedCollection) {
    return cachedCollection;
  }

  const collectionPromise = env.VECTORIZE_INDEX
    ? Promise.resolve(createVectorizeCollection(env.VECTORIZE_INDEX))
    : createLanceCollection(env);

  vectorCollectionCache.set(cacheKey, collectionPromise);

  return collectionPromise;
}
