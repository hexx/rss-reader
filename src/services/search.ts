import { inArray } from 'drizzle-orm';

import { db } from '../db/index.js';
import { articles, hatenaBookmarks } from '../db/schema.js';
import { getVectorCollection } from '../db/vector.js';
import { generateEmbedding } from './ai.js';
import type { RuntimeEnv } from '../env.js';

export interface SearchArticleResult {
  bookmarks: Array<{
    comment: string;
    createdAt: string;
    id: string;
    user: string;
  }>;
  createdAt: string;
  id: string;
  hatenaSummary: string;
  isRead: boolean;
  siteUrl: string;
  summary: string;
  title: string;
  url: string;
}

interface SearchChunkResult {
  article_id?: string;
}

interface SearchBookmarkRow {
  articleId: string;
  comment: string | null;
  createdAt: Date | string | number | null;
  id: string;
  user: string;
}

const maxSearchHits = 10;

function formatDate(value: Date | string | number | null | undefined): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === 'number') {
    return new Date(value).toISOString();
  }

  if (typeof value === 'string') {
    return new Date(value).toISOString();
  }

  return new Date().toISOString();
}

function uniqueArticleIds(articleIds: string[]): string[] {
  return [...new Set(articleIds)];
}

export async function searchArticles(
  query: string,
  env: RuntimeEnv = process.env,
): Promise<SearchArticleResult[]> {
  const normalizedQuery = query.trim();
  if (normalizedQuery.length === 0) {
    return [];
  }

  const embedding = await generateEmbedding(normalizedQuery, env);

  const collection = await getVectorCollection(env);
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
      createdAt: articles.createdAt,
      id: articles.id,
      hatenaSummary: articles.hatenaSummary,
      isRead: articles.isRead,
      siteUrl: articles.siteUrl,
      summary: articles.summary,
      title: articles.title,
      url: articles.url,
    })
    .from(articles)
    .where(inArray(articles.id, articleIds));

  const bookmarkRows =
    articleIds.length === 0
      ? []
      : await db
          .select({
            articleId: hatenaBookmarks.articleId,
            comment: hatenaBookmarks.comment,
            createdAt: hatenaBookmarks.createdAt,
            id: hatenaBookmarks.id,
            user: hatenaBookmarks.user,
          })
          .from(hatenaBookmarks)
          .where(inArray(hatenaBookmarks.articleId, articleIds));

  const bookmarksByArticleId = new Map<string, SearchBookmarkRow[]>();
  for (const bookmark of bookmarkRows) {
    const items = bookmarksByArticleId.get(bookmark.articleId) ?? [];
    items.push(bookmark);
    bookmarksByArticleId.set(bookmark.articleId, items);
  }

  const rowsById = new Map(rows.map((row) => [row.id, row]));

  return articleIds
    .map((articleId) => {
      const article = rowsById.get(articleId);
      if (!article) {
        return null;
      }

      return {
        bookmarks: (bookmarksByArticleId.get(article.id) ?? []).map((bookmark) => ({
          comment: bookmark.comment ?? '',
          createdAt: formatDate(bookmark.createdAt),
          id: bookmark.id,
          user: bookmark.user,
        })),
        createdAt: formatDate(article.createdAt),
        id: article.id,
        hatenaSummary: article.hatenaSummary?.trim() ?? '',
        isRead: article.isRead ?? false,
        siteUrl: article.siteUrl,
        summary: article.summary?.trim() ?? '',
        title: article.title,
        url: article.url,
      };
    })
    .filter((article): article is SearchArticleResult => article !== null);
}
