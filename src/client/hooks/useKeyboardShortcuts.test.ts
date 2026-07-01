import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Article } from '../types.js';
import { useKeyboardShortcuts } from './useKeyboardShortcuts.js';

const mockArticle: Article = {
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
};

const readArticle: Article = { ...mockArticle, id: 'article-2', isRead: true, title: '既読記事' };

describe('useKeyboardShortcuts', () => {
  beforeEach(() => {
    vi.spyOn(window, 'open').mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls onMarkAsRead when pressing "m" with an unread article', () => {
    const onMarkAsRead = vi.fn();

    renderHook(() => useKeyboardShortcuts([mockArticle], { onMarkAsRead }));

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm' }));
    });

    expect(onMarkAsRead).toHaveBeenCalledWith('article-1');
  });

  it('opens the article URL when pressing "v"', () => {
    const onMarkAsRead = vi.fn();

    renderHook(() => useKeyboardShortcuts([mockArticle], { onMarkAsRead }));

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'v' }));
    });

    expect(window.open).toHaveBeenCalledWith(
      'https://example.com/articles/1',
      '_blank',
      'noreferrer noopener',
    );
    expect(onMarkAsRead).not.toHaveBeenCalled();
  });

  it('opens Hatena entry URL when pressing "b"', () => {
    const onMarkAsRead = vi.fn();

    renderHook(() => useKeyboardShortcuts([mockArticle], { onMarkAsRead }));

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b' }));
    });

    expect(window.open).toHaveBeenCalledWith(
      'https://b.hatena.ne.jp/entry/s/example.com/articles/1',
      '_blank',
      'noreferrer noopener',
    );
    expect(onMarkAsRead).not.toHaveBeenCalled();
  });

  it('does nothing when there are no unread articles', () => {
    const onMarkAsRead = vi.fn();

    renderHook(() => useKeyboardShortcuts([readArticle], { onMarkAsRead }));

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm' }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'v' }));
    });

    expect(onMarkAsRead).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
  });

  it('ignores key events when the target is an INPUT element', () => {
    const onMarkAsRead = vi.fn();
    const input = document.createElement('input');
    document.body.append(input);

    renderHook(() => useKeyboardShortcuts([mockArticle], { onMarkAsRead }));

    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'm' }));
    });

    // INPUT 要素内のキーイベントは無視される（onMarkAsRead は呼ばれない）
    expect(onMarkAsRead).not.toHaveBeenCalled();

    document.body.removeChild(input);
  });

  it('reacts to window key events even when an INPUT is focused (event on window directly)', () => {
    const onMarkAsRead = vi.fn();

    renderHook(() => useKeyboardShortcuts([mockArticle], { onMarkAsRead }));

    // Window に直接 dispatch したイベントは target が window になるため INPUT 判定の対象外
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm' }));
    });

    expect(onMarkAsRead).toHaveBeenCalledTimes(1);
  });

  it('uses the first unread article for shortcut actions', () => {
    const onMarkAsRead = vi.fn();
    const articles = [readArticle, mockArticle]; // ReadArticle first, mockArticle second

    renderHook(() => useKeyboardShortcuts(articles, { onMarkAsRead }));

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm' }));
    });

    // 最初の未読記事（mockArticle）が対象になる
    expect(onMarkAsRead).toHaveBeenCalledWith('article-1');
  });

  it('does nothing for unrelated keys', () => {
    const onMarkAsRead = vi.fn();

    renderHook(() => useKeyboardShortcuts([mockArticle], { onMarkAsRead }));

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    });

    expect(onMarkAsRead).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
  });
});
