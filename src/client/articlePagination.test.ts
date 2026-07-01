import { describe, expect, it } from 'vitest';

import type { Article } from './types.js';
import { ARTICLE_PAGE_SIZE, buildArticlesUrl, mergeLoadedArticles, shouldShowLoadMore } from './articlePagination.js';

const articles: Article[] = [
  {
    bookmarks: [],
    content: '本文1',
    createdAt: '2024-01-01T00:00:00.000Z',
    hatenaSummary: '',
    id: 'article-1',
    isRead: false,
    publishedAt: '2024-01-01T00:00:00.000Z',
    siteUrl: 'https://example.com/',
    summary: '要約1',
    title: '記事1',
    url: 'https://example.com/articles/1',
  },
  {
    bookmarks: [],
    content: '本文2',
    createdAt: '2024-01-02T00:00:00.000Z',
    hatenaSummary: '',
    id: 'article-2',
    isRead: false,
    publishedAt: '2024-01-02T00:00:00.000Z',
    siteUrl: 'https://example.com/',
    summary: '要約2',
    title: '記事2',
    url: 'https://example.com/articles/2',
  },
];

describe('articlePagination', () => {
  it('builds articles urls with pagination parameters', () => {
    expect(
      buildArticlesUrl({
        sourceUrl: 'https://example.com/feed.xml',
        unreadOnly: true,
      }),
    ).toBe(`/api/articles?unread_only=true&limit=${ARTICLE_PAGE_SIZE}&offset=0&sort=asc&source=https%3A%2F%2Fexample.com%2Ffeed.xml`);
  });

  it('appends later pages and replaces the first page', () => {
    expect(mergeLoadedArticles(articles, [articles[1]!], 0)).toEqual([articles[1]]);
    expect(mergeLoadedArticles([articles[0]!], [articles[1]!], ARTICLE_PAGE_SIZE)).toEqual(articles);
  });

  it('shows load more only in the normal browsing state', () => {
    expect(shouldShowLoadMore(true, '')).toBe(true);
    expect(shouldShowLoadMore(false, '')).toBe(false);
    expect(shouldShowLoadMore(true, '検索')).toBe(false);
  });
});
