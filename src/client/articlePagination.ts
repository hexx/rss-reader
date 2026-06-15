import type { Article } from './types.js';

export const ARTICLE_PAGE_SIZE = 50;

type BuildArticlesUrlOptions = {
  limit?: number;
  offset?: number;
  sourceUrl?: string | undefined;
  sort?: 'asc' | 'desc';
  unreadOnly: boolean;
};

export function buildArticlesUrl({
  limit = ARTICLE_PAGE_SIZE,
  offset = 0,
  sourceUrl,
  sort = 'asc',
  unreadOnly,
}: BuildArticlesUrlOptions): string {
  const params = new URLSearchParams();
  params.set('unread_only', String(unreadOnly));
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  params.set('sort', sort);
  if (sourceUrl) {
    params.set('source', sourceUrl);
  }

  return `/api/articles?${params.toString()}`;
}

export function mergeLoadedArticles(articles: Article[], nextArticles: Article[], offset: number): Article[] {
  return offset === 0 ? nextArticles : [...articles, ...nextArticles];
}

export function shouldShowLoadMore(hasMore: boolean, searchQuery: string): boolean {
  return hasMore && searchQuery.trim().length === 0;
}
