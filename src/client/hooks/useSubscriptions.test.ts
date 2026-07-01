import { HttpResponse, http } from 'msw';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { server } from '../../test/setup.js';
import { useSubscriptions } from './useSubscriptions.js';

describe('useSubscriptions', () => {
  beforeEach(() => {
    server.resetHandlers();
  });

  afterEach(() => {
    server.resetHandlers();
  });

  it('adds a subscription successfully', async () => {
    server.use(
      http.post('*/api/subscriptions', async ({ request }) => {
        const body = (await request.json()) as { siteUrl?: string };
        expect(body.siteUrl).toBe('https://example.com/feed');
        return HttpResponse.json(
          { alreadyAFeed: true, feedType: 'rss', id: 'sub-1', siteUrl: 'https://example.com/feed', title: 'example.com' },
          { status: 201 },
        );
      }),
    );

    const onAfterChange = vi.fn();
    const { result } = renderHook(() => useSubscriptions({ onAfterChange }));

    await act(async () => {
      await result.current.add('https://example.com/feed');
    });

    expect(onAfterChange).toHaveBeenCalledTimes(1);
    expect(result.current.status?.kind).toBe('success');
    expect(result.current.status?.message).toBe('購読に追加しました。');
  });

  it('shows auto-discovery message when alreadyAFeed is false', async () => {
    server.use(
      http.post('*/api/subscriptions', () => 
        HttpResponse.json(
          {
            alreadyAFeed: false,
            feedType: 'rss',
            id: 'sub-1',
            siteUrl: 'https://example.com/feed.xml',
            title: 'example.com',
          },
          { status: 201 },
        )
      ),
    );

    const { result } = renderHook(() => useSubscriptions({ onAfterChange: vi.fn() }));

    await act(async () => {
      await result.current.add('https://example.com/');
    });

    expect(result.current.status?.kind).toBe('success');
    expect(result.current.status?.message).toBe('RSSフィードを自動検出して購読に追加しました。');
  });

  it('shows "Atom" when feedType is atom', async () => {
    server.use(
      http.post('*/api/subscriptions', () => 
        HttpResponse.json(
          {
            alreadyAFeed: false,
            feedType: 'atom',
            id: 'sub-1',
            siteUrl: 'https://example.com/atom.xml',
            title: 'example.com',
          },
          { status: 201 },
        )
      ),
    );

    const { result } = renderHook(() => useSubscriptions({ onAfterChange: vi.fn() }));

    await act(async () => {
      await result.current.add('https://example.com/');
    });

    expect(result.current.status?.kind).toBe('success');
    expect(result.current.status?.message).toBe('Atomフィードを自動検出して購読に追加しました。');
  });

  it('handles subscription add errors', async () => {
    server.use(
      http.post('*/api/subscriptions', () => 
        HttpResponse.json({ error: 'フィードが見つかりません。' }, { status: 400 })
      ),
    );

    const { result } = renderHook(() => useSubscriptions({ onAfterChange: vi.fn() }));

    // Add はエラーを throw する
    await act(async () => {
      try {
        await result.current.add('https://example.com/bad');
      } catch {
        // Expected
      }
    });

    expect(result.current.status?.kind).toBe('error');
    expect(result.current.status?.message).toBe('フィードが見つかりません。');
    expect(result.current.isAdding).toBe(false);
  });

  it('removes a subscription successfully', async () => {
    server.use(
      http.delete('*/api/subscriptions', async ({ request }) => {
        const body = (await request.json()) as { siteUrl?: string };
        expect(body.siteUrl).toBe('https://example.com/feed.xml');
        return HttpResponse.json({ siteUrl: 'https://example.com/feed.xml' });
      }),
    );

    const onAfterChange = vi.fn();
    const { result } = renderHook(() => useSubscriptions({ onAfterChange }));

    await act(async () => {
      await result.current.remove('https://example.com/feed.xml');
    });

    expect(onAfterChange).toHaveBeenCalledTimes(1);
    expect(result.current.status?.kind).toBe('success');
    expect(result.current.status?.message).toBe('購読を解除しました。');
  });

  it('handles subscription remove errors', async () => {
    server.use(
      http.delete('*/api/subscriptions', () => 
        HttpResponse.json({ error: '購読が見つかりません。' }, { status: 404 })
      ),
    );

    const { result } = renderHook(() => useSubscriptions({ onAfterChange: vi.fn() }));

    await act(async () => {
      try {
        await result.current.remove('https://example.com/nonexistent');
      } catch {
        // Expected
      }
    });

    expect(result.current.status?.kind).toBe('error');
    expect(result.current.status?.message).toBe('購読が見つかりません。');
    expect(result.current.removingSiteUrl).toBeNull();
  });

  it('resets isAdding to false after successful add', async () => {
    server.use(
      http.post('*/api/subscriptions', () => 
        HttpResponse.json(
          { id: 'sub-1', siteUrl: 'https://example.com/feed' },
          { status: 201 },
        )
      ),
    );

    const { result } = renderHook(() => useSubscriptions({ onAfterChange: vi.fn() }));

    expect(result.current.isAdding).toBe(false);

    await act(async () => {
      await result.current.add('https://example.com/feed');
    });

    expect(result.current.isAdding).toBe(false);
  });

  it('resets removingSiteUrl after successful remove', async () => {
    server.use(
      http.delete('*/api/subscriptions', () => 
        HttpResponse.json({ siteUrl: 'https://example.com/feed.xml' })
      ),
    );

    const { result } = renderHook(() => useSubscriptions({ onAfterChange: vi.fn() }));

    expect(result.current.removingSiteUrl).toBeNull();

    await act(async () => {
      await result.current.remove('https://example.com/feed.xml');
    });

    expect(result.current.removingSiteUrl).toBeNull();
  });
});
