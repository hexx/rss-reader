import 'dotenv/config';

import * as lancedb from '@lancedb/lancedb';
import type { Table } from '@lancedb/lancedb';

export const vectorDatabasePath = process.env.VECTOR_DB_PATH ?? './lancedb';
export const vectorCollectionName = 'article_chunks';
export const defaultVectorDimension = 1536;

let vectorCollectionPromise: Promise<Table> | undefined;

function getVectorDimension(): number {
  const rawValue = process.env.VECTOR_DIMENSION;

  if (rawValue === undefined || rawValue.trim() === '') {
    return defaultVectorDimension;
  }

  const dimension = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(dimension) || dimension <= 0) {
    throw new RangeError('VECTOR_DIMENSION must be a positive integer');
  }

  return dimension;
}

function createPlaceholderRow(): Record<string, unknown> {
  const vectorDimension = getVectorDimension();

  return {
    article_id: '__placeholder__',
    text: '',
    vector: Array.from({ length: vectorDimension }, () => 0),
  };
}

export function getVectorCollection(): Promise<Table> {
  vectorCollectionPromise ??= (async () => {
    const database = await lancedb.connect(vectorDatabasePath);
    const tableNames = await database.tableNames();

    if (tableNames.includes(vectorCollectionName)) {
      return database.openTable(vectorCollectionName);
    }

    const table = await database.createTable({
      name: vectorCollectionName,
      data: [createPlaceholderRow()],
    });

    await table.delete("article_id = '__placeholder__'");

    return table;
  })();

  return vectorCollectionPromise;
}
