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

const vectorCollectionCache = new WeakMap<object, VectorCollection>();

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

              return result.matches.map((match) => ((match.metadata !== undefined && typeof match.metadata.article_id === 'string'
                  ? { article_id: match.metadata.article_id }
                  : {})));
            },
          };
        },
      };
    },
  };
}

export function getVectorCollection(env: VectorEnv): Promise<VectorCollection> {
  if (!env.VECTORIZE_INDEX) {
    throw new Error('VECTORIZE_INDEX is required.');
  }

  const cacheKey = env as object;
  const cachedCollection = vectorCollectionCache.get(cacheKey);
  if (cachedCollection) {
    return Promise.resolve(cachedCollection);
  }

  const collection = createVectorizeCollection(env.VECTORIZE_INDEX);
  vectorCollectionCache.set(cacheKey, collection);

  return Promise.resolve(collection);
}
