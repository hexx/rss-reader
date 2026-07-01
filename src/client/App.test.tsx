import { HttpResponse, http } from 'msw';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { server } from '../test/setup.js';
import { App } from './App.js';

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

    render(<App />);

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

    render(<App />);

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

  it('filters articles by search query', async () => {
    const twoArticles = {
      articles: [
        {
          bookmarks: [],
          content: '',
          createdAt: '2024-01-01T00:00:00.000Z',
          hatenaSummary: '',
          id: 'article-1',
          isRead: false,
          publishedAt: '2024-01-01T00:00:00.000Z',
          siteUrl: 'https://example.com/feed.xml',
          summary: '',
          title: 'React入門',
          url: 'https://example.com/articles/1',
        },
        {
          bookmarks: [],
          content: '',
          createdAt: '2024-01-02T00:00:00.000Z',
          hatenaSummary: '',
          id: 'article-2',
          isRead: false,
          publishedAt: '2024-01-02T00:00:00.000Z',
          siteUrl: 'https://example.com/feed.xml',
          summary: '',
          title: 'Python入門',
          url: 'https://example.com/articles/2',
        },
      ],
    };

    server.use(
      http.get('*/api/sources', () => HttpResponse.json(sourcesResponse)),
      http.get('*/api/articles', () => HttpResponse.json(twoArticles)),
    );

    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('React入門')).toBeInTheDocument();
      expect(screen.getByText('Python入門')).toBeInTheDocument();
    });

    // 検索ボックスに "React" と入力
    const searchInput = screen.getByPlaceholderText('記事を検索...');
    await user.type(searchInput, 'React');

    // 検索ボタンをクリック
    await user.click(screen.getByRole('button', { name: '検索' }));

    // 「React入門」のみ表示され、「Python入門」は非表示
    expect(screen.getByText('React入門')).toBeInTheDocument();
    expect(screen.queryByText('Python入門')).not.toBeInTheDocument();
  });

  it('shows sidebar with source manager on desktop', async () => {
    server.use(
      http.get('*/api/sources', () => HttpResponse.json(sourcesResponse)),
      http.get('*/api/articles', () => HttpResponse.json(articlesResponse)),
    );

    render(<App />);

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

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('記事の読み込みに失敗しました。')).toBeInTheDocument();
    });
  });
});
