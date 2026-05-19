import { describe, expect, it } from 'vitest';

import { applyReadStateChange } from './articleState.js';
import type { Article } from './types.js';

const articles: Article[] = [
  {
    bookmarks: [],
    content: '本文',
    createdAt: '2024-01-01T00:00:00.000Z',
    hatenaSummary: '',
    id: 'article-1',
    isRead: false,
    publishedAt: '2024-01-01T00:00:00.000Z',
    siteUrl: 'https://example.com/',
    summary: '要約',
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

describe('applyReadStateChange', () => {
  it('removes the article immediately when unread-only mode is active', () => {
    const result = applyReadStateChange([...articles], 'article-1', true, true);

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('article-2');
  });

  it('keeps the article when unread-only mode is inactive', () => {
    const result = applyReadStateChange([...articles], 'article-1', true, false);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ id: 'article-1', isRead: true });
  });
});
