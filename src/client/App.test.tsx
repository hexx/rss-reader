import { QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { makeQueryClient } from './queryClient.js';
import { server } from '../test/setup.js';
import { App } from './App.js';

function renderApp() {
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <App />
    </QueryClientProvider>,
  );
}

const sourcesResponse = {
  sources: [
    {
      articleCount: 2,
      displayTitle: 'Example Feed',
      id: 'source-1',
      siteUrl: 'https://example.com/feed.xml',
      title: 'Example Feed',
      unreadCount: 1,
    },
  ],
};

const articlesResponse = {
  articles: [
    {
      bookmarks: [
        {
          comment: '参考になる',
          createdAt: '2024-01-01T00:00:00.000Z',
          id: 'bookmark-1',
          user: 'alice',
        },
      ],
      content: '<p>記事本文</p>',
      createdAt: '2024-01-01T00:00:00.000Z',
      hatenaSummary: '<p>はてブ要約</p>',
      id: 'article-1',
      isRead: false,
      publishedAt: '2024-01-01T00:00:00.000Z',
      siteUrl: 'https://example.com/feed.xml',
      summary: '<p>記事要約</p>',
      title: '最初の記事',
      url: 'https://example.com/articles/1',
    },
  ],
};

describe('App', () => {
  afterEach(() => {
    server.resetHandlers();
  });

  it('renders the app header and loads articles', async () => {
    server.use(
      http.get('*/api/sources', () => HttpResponse.json(sourcesResponse)),
      http.get('*/api/articles', () => HttpResponse.json(articlesResponse)),
    );

    renderApp();

    // ヘッダーが表示される
    expect(screen.getByText('RSS Reader')).toBeInTheDocument();

    // 記事が読み込まれるまで待つ
    await waitFor(() => {
      expect(screen.getByText('最初の記事')).toBeInTheDocument();
    });

    // 未読数バッジ
    expect(screen.getByText('1 未読')).toBeInTheDocument();
  });

  it('performs optimistic update when marking article as read', async () => {
    // 成功する PATCH レスポンス
    server.use(
      http.get('*/api/sources', () => HttpResponse.json(sourcesResponse)),
      http.get('*/api/articles', () => HttpResponse.json(articlesResponse)),
      http.patch('*/api/articles/article-1', () =>
        HttpResponse.json({ id: 'article-1', isRead: true }),
      ),
    );

    renderApp();

    await waitFor(() => {
      expect(screen.getByText('最初の記事')).toBeInTheDocument();
    });

    // 「既読にする」ボタンをクリック
    const markReadButtons = screen.getAllByRole('button', { name: '既読にする' });
    const innerButton = markReadButtons.find((btn) => btn.dataset.slot === 'button');
    expect(innerButton).not.toBeNull();

    const user = userEvent.setup();
    await user.click(innerButton!);

    // 未読のみモードでは、既読化した記事が即座に DOM から削除される（Optimistic Update）
    await waitFor(() => {
      expect(screen.queryByText('最初の記事')).not.toBeInTheDocument();
    });

    // 成功メッセージが表示される
    expect(screen.getByText('既読にしました。')).toBeInTheDocument();
  });

  it('decrements unread counts optimistically before the PATCH resolves', async () => {
    let patchCount = 0;
    let resolvePatch: (() => void) | null = null;

    server.use(
      // PATCH 後はサーバ真値も unreadCount: 0 を返す
      http.get('*/api/sources', () =>
        HttpResponse.json({
          sources: [
            { ...sourcesResponse.sources[0], unreadCount: patchCount > 0 ? 0 : 1 },
          ],
        }),
      ),
      http.get('*/api/articles', () => HttpResponse.json(articlesResponse)),
      http.patch('*/api/articles/article-1', async () => {
        patchCount++;
        await new Promise<void>((resolve) => {
          resolvePatch = resolve;
        });
        return HttpResponse.json({ id: 'article-1', isRead: true });
      }),
    );

    renderApp();
    await waitFor(() => {
      expect(screen.getByText('最初の記事')).toBeInTheDocument();
    });
    expect(screen.getByText('1 未読')).toBeInTheDocument();

    const markReadButtons = screen.getAllByRole('button', { name: '既読にする' });
    const innerButton = markReadButtons.find((btn) => btn.dataset.slot === 'button');
    expect(innerButton).not.toBeNull();

    const user = userEvent.setup();
    await user.click(innerButton!);

    // PATCH 未解決の時点で、ヘッダー総未読数とサイドバーのバッジが即座に減る
    await waitFor(() => {
      expect(screen.queryByText('1 未読')).not.toBeInTheDocument();
    });
    expect(patchCount).toBe(1);

    // PATCH を解決すると、サイレント refetch 後も 0 のまま
    await act(async () => {
      resolvePatch?.();
    });
    await waitFor(() => {
      expect(screen.getByText('既読にしました。')).toBeInTheDocument();
    });
    expect(screen.queryByText('1 未読')).not.toBeInTheDocument();
  });

  it('rolls back unread counts when the PATCH fails', async () => {
    server.use(
      http.get('*/api/sources', () => HttpResponse.json(sourcesResponse)),
      http.get('*/api/articles', () => HttpResponse.json(articlesResponse)),
      http.patch('*/api/articles/article-1', () =>
        new HttpResponse(null, { status: 500 }),
      ),
    );

    renderApp();
    await waitFor(() => {
      expect(screen.getByText('最初の記事')).toBeInTheDocument();
    });
    expect(screen.getByText('1 未読')).toBeInTheDocument();

    const markReadButtons = screen.getAllByRole('button', { name: '既読にする' });
    const innerButton = markReadButtons.find((btn) => btn.dataset.slot === 'button');
    expect(innerButton).not.toBeNull();

    const user = userEvent.setup();
    await user.click(innerButton!);

    // 失敗後は楽観更新が巻き戻され、未読数が元に戻る
    await waitFor(() => {
      expect(screen.getByText('既読状態の更新に失敗しました。')).toBeInTheDocument();
    });
    expect(screen.getByText('1 未読')).toBeInTheDocument();
  });

  it('decrements only once when the same article is marked read twice rapidly', async () => {
    let patchCount = 0;
    let resolvePatch: (() => void) | null = null;
    const twoUnreadSources = {
      sources: [{ ...sourcesResponse.sources[0], unreadCount: 2 }],
    };

    server.use(
      http.get('*/api/sources', () =>
        HttpResponse.json({
          sources: [
            { ...twoUnreadSources.sources[0], unreadCount: patchCount > 0 ? 1 : 2 },
          ],
        }),
      ),
      http.get('*/api/articles', () => HttpResponse.json(articlesResponse)),
      http.patch('*/api/articles/article-1', async () => {
        patchCount++;
        await new Promise<void>((resolve) => {
          resolvePatch = resolve;
        });
        return HttpResponse.json({ id: 'article-1', isRead: true });
      }),
    );

    renderApp();
    await waitFor(() => {
      expect(screen.getByText('2 未読')).toBeInTheDocument();
    });

    // 再レンダーを挟まずに 'm' を二連打（同一クロージャからの二重発火を再現）
    act(() => {
      fireEvent.keyDown(window, { key: 'm' });
      fireEvent.keyDown(window, { key: 'm' });
    });

    // in-flight ガードにより PATCH も減算も 1 回のみ
    await waitFor(() => {
      expect(patchCount).toBe(1);
    });
    await waitFor(() => {
      expect(screen.getByText('1 未読')).toBeInTheDocument();
    });
    expect(screen.queryByText('2 未読')).not.toBeInTheDocument();

    await act(async () => {
      resolvePatch?.();
    });
    await waitFor(() => {
      expect(screen.getByText('既読にしました。')).toBeInTheDocument();
    });
  });

  it('clamps unread count at zero when the cached count is already zero', async () => {
    server.use(
      // ドリフトでキャッシュの未読数が 0 だが、未読記事が存在するケース
      http.get('*/api/sources', () =>
        HttpResponse.json({
          sources: [{ ...sourcesResponse.sources[0], unreadCount: 0 }],
        }),
      ),
      http.get('*/api/articles', () => HttpResponse.json(articlesResponse)),
      http.patch('*/api/articles/article-1', () =>
        HttpResponse.json({ id: 'article-1', isRead: true }),
      ),
    );

    renderApp();
    await waitFor(() => {
      expect(screen.getByText('最初の記事')).toBeInTheDocument();
    });

    const markReadButtons = screen.getAllByRole('button', { name: '既読にする' });
    const innerButton = markReadButtons.find((btn) => btn.dataset.slot === 'button');
    expect(innerButton).not.toBeNull();

    const user = userEvent.setup();
    await user.click(innerButton!);

    await waitFor(() => {
      expect(screen.getByText('既読にしました。')).toBeInTheDocument();
    });
    // 負のバッジは表示されない
    expect(screen.queryByText('-1')).not.toBeInTheDocument();
  });

  it('shows sidebar with source manager on desktop', async () => {
    server.use(
      http.get('*/api/sources', () => HttpResponse.json(sourcesResponse)),
      http.get('*/api/articles', () => HttpResponse.json(articlesResponse)),
    );

    renderApp();

    await waitFor(() => {
      expect(screen.getByText('最初の記事')).toBeInTheDocument();
    });

    // サイドバーに SourceManager が表示される
    expect(screen.getByText('購読設定')).toBeInTheDocument();
  });

  it('shows error status when API fails', async () => {
    server.use(
      http.get('*/api/sources', () => HttpResponse.json(sourcesResponse)),
      http.get('*/api/articles', () => new HttpResponse(null, { status: 500 })),
    );

    renderApp();

    await waitFor(() => {
      expect(screen.getByText('記事の読み込みに失敗しました。')).toBeInTheDocument();
    });
  });
});
