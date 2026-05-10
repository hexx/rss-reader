import 'dotenv/config';

import { Field, FixedSizeList, Float32, Schema, Utf8 } from 'apache-arrow';
import * as lancedb from 'vectordb';
import type { Table } from 'vectordb';

export const vectorDatabasePath = './lancedb';
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

function createVectorSchema(): Schema {
  const vectorDimension = getVectorDimension();

  return new Schema([
    new Field('article_id', new Utf8(), false),
    new Field('text', new Utf8(), false),
    new Field(
      'vector',
      new FixedSizeList(vectorDimension, new Field('item', new Float32(), true)),
      false,
    ),
  ]);
}

export function getVectorCollection(): Promise<Table> {
  vectorCollectionPromise ??= (async () => {
    const database = await lancedb.connect(vectorDatabasePath);
    const tableNames = await database.tableNames();

    if (tableNames.includes(vectorCollectionName)) {
      return database.openTable(vectorCollectionName);
    }

    return database.createTable({
      name: vectorCollectionName,
      schema: createVectorSchema(),
    });
  })();

  return vectorCollectionPromise;
}
