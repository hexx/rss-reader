import { http, HttpResponse } from 'msw';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { server } from '../../test/setup.js';
import type { Source } from '../types.js';
import { useSources } from './useSources.js';

const mockSources: Source[] = [
  {
    articleCount: 5,
    displayTitle: 'Example Feed',
    id: 'source-1',
    siteUrl: 'https://example.com/feed.xml',
    title: 'Example Feed',
    unreadCount: 2,
  },
  {
    articleCount: 3,
    displayTitle: 'Another Blog',
    id: 'source-2',
    siteUrl: 'https://another.example/rss',
    title: 'Another Blog',
    unreadCount: 0,
  },
];

describe('useSources', () => {
  beforeEach(() => {
    server.resetHandlers();
  });

  afterEach(() => {
    server.resetHandlers();
  });

  it('fetches sources on mount and sets them in state', async () => {
    server.use(
      http.get('*/api/sources', () => {
        return HttpResponse.json({ sources: mockSources });
      }),
    );

    const { result } = renderHook(() => useSources());

    // 初回はローディング
    expect(result.current.isLoading).toBe(true);

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.sources).toHaveLength(2);
    expect(result.current.sources[0]?.title).toBe('Example Feed');
    expect(result.current.sources[1]?.siteUrl).toBe('https://another.example/rss');
  });

  it('reload refetches sources', async () => {
    let callCount = 0;

    server.use(
      http.get('*/api/sources', () => {
        callCount++;
        return HttpResponse.json({
          sources: callCount === 1 ? [mockSources[0]] : mockSources,
        });
      }),
    );

    const { result } = renderHook(() => useSources());

    await waitFor(() => {
      expect(result.current.sources).toHaveLength(1);
    });
    expect(callCount).toBe(1);

    // reload を呼ぶ
    await act(async () => {
      await result.current.reload();
    });

    expect(result.current.sources).toHaveLength(2);
    expect(callCount).toBe(2);
  });

  it('handles API errors', async () => {
    server.use(
      http.get('*/api/sources', () => {
        return new HttpResponse(null, { status: 500 });
      }),
    );

    const { result } = renderHook(() => useSources());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.sources).toHaveLength(0);
    expect(result.current.status?.kind).toBe('error');
    expect(result.current.status?.message).toBe('購読ソースの読み込みに失敗しました。');
  });

  it('handles malformed responses as empty array', async () => {
    server.use(
      http.get('*/api/sources', () => {
        return HttpResponse.json({});
      }),
    );

    const { result } = renderHook(() => useSources());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.sources).toHaveLength(0);
  });

  it('handles non-array sources field as empty array', async () => {
    server.use(
      http.get('*/api/sources', () => {
        return HttpResponse.json({ sources: null });
      }),
    );

    const { result } = renderHook(() => useSources());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.sources).toHaveLength(0);
  });
});
