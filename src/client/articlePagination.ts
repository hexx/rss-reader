import type { Article } from './types.js';

export const ARTICLE_PAGE_SIZE = 50;

type BuildArticlesUrlOptions = {
  limit?: number;
  offset?: number;
  sourceUrl?: string | undefined;
  unreadOnly: boolean;
};

export function buildArticlesUrl({
  limit = ARTICLE_PAGE_SIZE,
  offset = 0,
  sourceUrl,
  unreadOnly,
}: BuildArticlesUrlOptions): string {
  const params = new URLSearchParams();
  params.set('unread_only', String(unreadOnly));
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  if (sourceUrl) {
    params.set('source', sourceUrl);
  }

  return `/api/articles?${params.toString()}`;
}

export function mergeLoadedArticles(articles: Article[], nextArticles: Article[], offset: number): Article[] {
  return offset === 0 ? nextArticles : [...articles, ...nextArticles];
}

export function shouldShowLoadMore(hasMore: boolean, searchQuery: string, aiAnswer: string): boolean {
  return hasMore && searchQuery.trim().length === 0 && aiAnswer.trim().length === 0;
}
