import { embed } from 'ai';
import { inArray } from 'drizzle-orm';

import { db } from '../db/index.js';
import { articles } from '../db/schema.js';
import { getVectorCollection } from '../db/vector.js';
import { getOpenCodeGoEmbeddingModel } from './ai.js';

export interface SearchArticleResult {
  id: string;
  summary: string;
  title: string;
  url: string;
}

interface SearchChunkResult {
  article_id?: string;
}

const maxSearchHits = 10;

function uniqueArticleIds(articleIds: string[]): string[] {
  return [...new Set(articleIds)];
}

export async function searchArticles(query: string): Promise<SearchArticleResult[]> {
  const normalizedQuery = query.trim();
  if (normalizedQuery.length === 0) {
    return [];
  }

  const vectorModel = getOpenCodeGoEmbeddingModel();
  const { embedding } = await embed({
    model: vectorModel,
    value: normalizedQuery,
  });

  const collection = await getVectorCollection();
  const chunkResults = (await collection.search(embedding).limit(maxSearchHits).toArray()) as SearchChunkResult[];
  const articleIds = uniqueArticleIds(
    chunkResults
      .map((result) => result.article_id)
      .filter((articleId): articleId is string => typeof articleId === 'string' && articleId.length > 0),
  );

  if (articleIds.length === 0) {
    return [];
  }

  const rows = await db
    .select({
      id: articles.id,
      summary: articles.summary,
      title: articles.title,
      url: articles.url,
    })
    .from(articles)
    .where(inArray(articles.id, articleIds));

  const rowsById = new Map(rows.map((row) => [row.id, row]));

  return articleIds
    .map((articleId) => {
      const article = rowsById.get(articleId);
      if (!article) {
        return null;
      }

      return {
        id: article.id,
        summary: article.summary?.trim() ?? '',
        title: article.title,
        url: article.url,
      };
    })
    .filter((article): article is SearchArticleResult => article !== null);
}
