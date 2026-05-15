import 'dotenv/config';

import * as lancedb from '@lancedb/lancedb';
import type { Table } from '@lancedb/lancedb';

import type { RuntimeEnv } from '../env.js';

export function getVectorDatabasePath(env: RuntimeEnv = process.env): string {
  return env.VECTOR_DB_PATH?.trim() || './lancedb';
}

export const vectorCollectionName = 'article_chunks';
export const defaultVectorDimension = 1536;

const vectorCollectionCache = new WeakMap<object, Promise<Table>>();

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

function createPlaceholderRow(env: RuntimeEnv): Record<string, unknown> {
  const vectorDimension = getVectorDimension(env);

  return {
    article_id: '__placeholder__',
    text: '',
    vector: Array.from({ length: vectorDimension }, () => 0),
  };
}

export function getVectorCollection(env: RuntimeEnv = process.env): Promise<Table> {
  const cacheKey = env as object;
  const cachedCollection = vectorCollectionCache.get(cacheKey);
  if (cachedCollection) {
    return cachedCollection;
  }

  const collectionPromise = (async () => {
    const database = await lancedb.connect(getVectorDatabasePath(env));
    const tableNames = await database.tableNames();

    if (tableNames.includes(vectorCollectionName)) {
      return database.openTable(vectorCollectionName);
    }

    const table = await database.createTable({
      name: vectorCollectionName,
      data: [createPlaceholderRow(env)],
    });

    await table.delete("article_id = '__placeholder__'");

    return table;
  })();

  vectorCollectionCache.set(cacheKey, collectionPromise);

  return collectionPromise;
}
