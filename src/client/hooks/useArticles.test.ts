import { http, HttpResponse } from 'msw';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { server } from '../../test/setup.js';
import { ARTICLE_PAGE_SIZE } from '../articlePagination.js';
import type { Article, ArticleSortDirection } from '../types.js';
import { useArticles } from './useArticles.js';

const baseArticle: Omit<Article, 'id' | 'title'> = {
  bookmarks: [],
  content: '',
  createdAt: '2024-01-01T00:00:00.000Z',
  hatenaSummary: '',
  isRead: false,
  publishedAt: '2024-01-01T00:00:00.000Z',
  siteUrl: 'https://example.com/',
  summary: '',
  url: 'https://example.com/articles/',
};

function createArticles(count: number, startId = 0): Article[] {
  return Array.from({ length: count }, (_, index) => ({
    ...baseArticle,
    id: `article-${startId + index}`,
    title: `Article ${startId + index}`,
    url: `${baseArticle.url}${startId + index}`,
  }));
}

const defaultParams = {
  selectedSourceUrl: undefined,
  showUnreadOnly: true,
  sortOrder: 'asc' as ArticleSortDirection,
};

describe('useArticles', () => {
  beforeEach(() => {
    server.resetHandlers();
  });

  afterEach(() => {
    server.resetHandlers();
  });

  it('fetches articles on mount and sets them in state', async () => {
    const articles = createArticles(2);

    server.use(
      http.get('*/api/articles', ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get('unread_only')).toBe('true');
        expect(url.searchParams.get('limit')).toBe(String(ARTICLE_PAGE_SIZE));
        expect(url.searchParams.get('offset')).toBe('0');
        return HttpResponse.json({ articles });
      }),
    );

    const { result } = renderHook(() => useArticles(defaultParams));

    // 初回はローディング
    expect(result.current.isLoading).toBe(true);

    // 記事が読み込まれるまで待つ
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.articles).toHaveLength(2);
    expect(result.current.articles[0]?.title).toBe('Article 0');
    expect(result.current.hasMore).toBe(false);
    expect(result.current.status?.kind).toBe('success');
  });

  it('loadMore appends articles and updates offset', async () => {
    let callCount = 0;

    server.use(
      http.get('*/api/articles', ({ request }) => {
        const url = new URL(request.url);
        const offset = Number(url.searchParams.get('offset'));
        callCount++;
        // 1ページ目: 50件返す → hasMore = true
        // 2ページ目: 10件返す → hasMore = false
        const count = offset === 0 ? ARTICLE_PAGE_SIZE : 10;
        return HttpResponse.json({ articles: createArticles(count, offset) });
      }),
    );

    const { result } = renderHook(() => useArticles(defaultParams));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.articles).toHaveLength(ARTICLE_PAGE_SIZE);
    expect(result.current.hasMore).toBe(true);
    expect(callCount).toBe(1);

    // loadMore を呼ぶ
    act(() => {
      result.current.loadMore();
    });

    await waitFor(() => {
      expect(result.current.articles).toHaveLength(ARTICLE_PAGE_SIZE + 10);
    });

    expect(result.current.hasMore).toBe(false);
    expect(callCount).toBe(2);
  });

  it('refresh resets articles and starts from scratch', async () => {
    let callCount = 0;

    server.use(
      http.get('*/api/articles', () => {
        callCount++;
        return HttpResponse.json({ articles: createArticles(5) });
      }),
    );

    const { result } = renderHook(() => useArticles(defaultParams));

    await waitFor(() => {
      expect(result.current.articles).toHaveLength(5);
    });
    expect(callCount).toBe(1);

    // refresh で最初から再読み込み
    act(() => {
      result.current.refresh();
    });

    await waitFor(() => {
      expect(result.current.articles).toHaveLength(5);
    });
    expect(callCount).toBe(2);
  });

  it('handles API errors gracefully', async () => {
    server.use(
      http.get('*/api/articles', () => {
        return new HttpResponse(null, { status: 500 });
      }),
    );

    const { result } = renderHook(() => useArticles(defaultParams));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.articles).toHaveLength(0);
    expect(result.current.status?.kind).toBe('error');
    expect(result.current.status?.message).toBe('記事の読み込みに失敗しました。');
  });

  it('shows different status messages based on unreadOnly and page', async () => {
    server.use(
      http.get('*/api/articles', () => {
        return HttpResponse.json({ articles: [] });
      }),
    );

    const { result } = renderHook(() =>
      useArticles({ ...defaultParams, showUnreadOnly: true }),
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.status?.message).toBe('未読記事がありません。');
  });

  it('shows "これ以上の記事はありません" on subsequent pages with empty results', async () => {
    let callCount = 0;

    server.use(
      http.get('*/api/articles', () => {
        callCount++;
        // 1回目は50件, 2回目は0件
        if (callCount === 1) {
          return HttpResponse.json({ articles: createArticles(ARTICLE_PAGE_SIZE) });
        }
        return HttpResponse.json({ articles: [] });
      }),
    );

    const { result } = renderHook(() =>
      useArticles({ ...defaultParams, showUnreadOnly: false }),
    );

    await waitFor(() => {
      expect(result.current.hasMore).toBe(true);
    });

    act(() => {
      result.current.loadMore();
    });

    await waitFor(() => {
      expect(result.current.status?.message).toBe('これ以上の記事はありません。');
    });
  });

  it('includes sourceUrl in the API request when a source is selected', async () => {
    server.use(
      http.get('*/api/articles', ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get('source')).toBe('https://example.com/feed.xml');
        return HttpResponse.json({ articles: createArticles(1) });
      }),
    );

    const { result } = renderHook(() =>
      useArticles({
        ...defaultParams,
        selectedSourceUrl: 'https://example.com/feed.xml',
      }),
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.articles).toHaveLength(1);
  });

  it('passes sort direction to the API', async () => {
    server.use(
      http.get('*/api/articles', ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get('sort')).toBe('desc');
        return HttpResponse.json({ articles: createArticles(1) });
      }),
    );

    const { result } = renderHook(() =>
      useArticles({ ...defaultParams, sortOrder: 'desc' }),
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.articles).toHaveLength(1);
  });

  it('clearStatus resets the status to null', async () => {
    server.use(
      http.get('*/api/articles', () => {
        return new HttpResponse(null, { status: 500 });
      }),
    );

    const { result } = renderHook(() => useArticles(defaultParams));

    await waitFor(() => {
      expect(result.current.status?.kind).toBe('error');
    });

    act(() => {
      result.current.clearStatus();
    });

    expect(result.current.status).toBeNull();
  });

  it('setArticles allows direct state manipulation', async () => {
    const articles = createArticles(2);

    server.use(
      http.get('*/api/articles', () => {
        return HttpResponse.json({ articles });
      }),
    );

    const { result } = renderHook(() => useArticles(defaultParams));

    await waitFor(() => {
      expect(result.current.articles).toHaveLength(2);
    });

    act(() => {
      result.current.setArticles([]);
    });

    expect(result.current.articles).toHaveLength(0);
  });
});
