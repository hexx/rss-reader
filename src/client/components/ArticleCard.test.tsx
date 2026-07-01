import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { Article } from '../types.js';
import { ArticleCard } from './ArticleCard.js';

const baseArticle: Article = {
  bookmarks: [],
  content: '<p>記事本文</p>',
  createdAt: '2024-01-01T00:00:00.000Z',
  hatenaSummary: '',
  id: 'article-1',
  isRead: false,
  publishedAt: '2024-01-01T00:00:00.000Z',
  siteUrl: 'https://example.com/feed.xml',
  summary: '<p>要約文です。</p>',
  title: 'テスト記事タイトル',
  url: 'https://example.com/articles/1',
};

/** Tooltip のトリガーが外側に button 要素をレンダリングするため、
 * 内側の実際の Button コンポーネントをデータ属性で特定する */
function getInnerMarkAsReadButton(): HTMLElement | null {
  const allButtons = screen.getAllByRole('button', { name: '既読にする' });
  // data-slot="button" が内側の実際の Button コンポーネント
  return allButtons.find((btn) => btn.getAttribute('data-slot') === 'button') ?? null;
}

describe('ArticleCard', () => {
  it('renders the article title and URL', () => {
    render(<ArticleCard article={baseArticle} onMarkAsRead={vi.fn()} />);

    expect(screen.getByText('テスト記事タイトル')).toBeInTheDocument();
    const urlLink = screen.getByText('https://example.com/articles/1');
    expect(urlLink).toBeInTheDocument();
    expect(urlLink.closest('a')).toHaveAttribute('href', 'https://example.com/articles/1');
  });

  it('shows the source hostname label', () => {
    render(<ArticleCard article={baseArticle} onMarkAsRead={vi.fn()} />);

    expect(screen.getByText('example.com')).toBeInTheDocument();
  });

  it('formats the published date', () => {
    render(<ArticleCard article={baseArticle} onMarkAsRead={vi.fn()} />);

    const time = screen.getByText(/2024/);
    expect(time).toBeInTheDocument();
  });

  it('shows "日時不明" for invalid dates', () => {
    const article = { ...baseArticle, publishedAt: 'invalid-date' };
    render(<ArticleCard article={article} onMarkAsRead={vi.fn()} />);

    expect(screen.getByText('日時不明')).toBeInTheDocument();
  });

  it('shows the bookmark count badge when there are bookmarks', () => {
    const article: Article = {
      ...baseArticle,
      bookmarks: [
        { comment: '良い記事', createdAt: '2024-01-01T00:00:00.000Z', id: 'b1', user: 'alice' },
        { comment: '参考になる', createdAt: '2024-01-02T00:00:00.000Z', id: 'b2', user: 'bob' },
      ],
    };
    render(<ArticleCard article={article} onMarkAsRead={vi.fn()} />);

    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('does not show the bookmark badge when there are no bookmarks', () => {
    render(<ArticleCard article={baseArticle} onMarkAsRead={vi.fn()} />);

    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('shows the summary section when summary is non-empty', () => {
    render(<ArticleCard article={baseArticle} onMarkAsRead={vi.fn()} />);

    expect(screen.getByText('記事の要約')).toBeInTheDocument();
    expect(screen.getByText('要約文です。')).toBeInTheDocument();
  });

  it('hides the summary section when summary is empty', () => {
    const article = { ...baseArticle, summary: '' };
    render(<ArticleCard article={article} onMarkAsRead={vi.fn()} />);

    expect(screen.queryByText('記事の要約')).not.toBeInTheDocument();
  });

  it('shows the hatena summary section when hatenaSummary is non-empty', () => {
    const article = { ...baseArticle, hatenaSummary: '<p>反応要約</p>' };
    render(<ArticleCard article={article} onMarkAsRead={vi.fn()} />);

    expect(screen.getByText('はてブの反応')).toBeInTheDocument();
    expect(screen.getByText('反応要約')).toBeInTheDocument();
  });

  it('hides the hatena summary section when hatenaSummary is empty', () => {
    render(<ArticleCard article={baseArticle} onMarkAsRead={vi.fn()} />);

    expect(screen.queryByText('はてブの反応')).not.toBeInTheDocument();
  });

  it('shows visible bookmarks (non-empty comment) and hides empty ones', () => {
    const article: Article = {
      ...baseArticle,
      bookmarks: [
        { comment: '良い記事', createdAt: '2024-01-01T00:00:00.000Z', id: 'b1', user: 'alice' },
        { comment: '', createdAt: '2024-01-02T00:00:00.000Z', id: 'b2', user: 'bob' },
      ],
    };
    render(<ArticleCard article={article} onMarkAsRead={vi.fn()} />);

    expect(screen.getByText('良い記事')).toBeInTheDocument();
    // 空コメント（タグのみ）のブックマークは表示されない
    expect(screen.queryByText(/bob/)).not.toBeInTheDocument();
    // 件数表示は全件（2件）
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('shows the mark-as-read button for unread articles', () => {
    render(<ArticleCard article={baseArticle} onMarkAsRead={vi.fn()} />);

    // TooltipTrigger と Button の二重 button 要素があるが少なくとも1つ存在する
    const buttons = screen.getAllByRole('button', { name: '既読にする' });
    expect(buttons.length).toBeGreaterThanOrEqual(1);
  });

  it('hides the mark-as-read button for read articles', () => {
    const article = { ...baseArticle, isRead: true };
    render(<ArticleCard article={article} onMarkAsRead={vi.fn()} />);

    expect(screen.queryByRole('button', { name: '既読にする' })).not.toBeInTheDocument();
  });

  it('calls onMarkAsRead when the inner mark-as-read button is clicked', async () => {
    const onMarkAsRead = vi.fn();
    const user = userEvent.setup();

    render(<ArticleCard article={baseArticle} onMarkAsRead={onMarkAsRead} />);

    const innerButton = getInnerMarkAsReadButton();
    expect(innerButton).not.toBeNull();

    await user.click(innerButton!);

    expect(onMarkAsRead).toHaveBeenCalledWith('article-1');
  });

  it('renders the article title as a link to the article URL', () => {
    render(<ArticleCard article={baseArticle} onMarkAsRead={vi.fn()} />);

    const titleLink = screen.getByText('テスト記事タイトル').closest('a');
    expect(titleLink).toHaveAttribute('href', 'https://example.com/articles/1');
    expect(titleLink).toHaveAttribute('target', '_blank');
    expect(titleLink).toHaveAttribute('rel', 'noreferrer noopener');
  });

  it('renders the "コメントを読む" link pointing to Hatena entry page', () => {
    render(<ArticleCard article={baseArticle} onMarkAsRead={vi.fn()} />);

    const commentLink = screen.getByText('コメントを読む');
    expect(commentLink.closest('a')).toHaveAttribute(
      'href',
      'https://b.hatena.ne.jp/entry/s/example.com/articles/1',
    );
  });

  it('renders the "記事を読む" link pointing to the article URL', () => {
    render(<ArticleCard article={baseArticle} onMarkAsRead={vi.fn()} />);

    const readLink = screen.getByText('記事を読む');
    expect(readLink.closest('a')).toHaveAttribute('href', 'https://example.com/articles/1');
  });

  it('sets data-article-id attribute', () => {
    const { container } = render(<ArticleCard article={baseArticle} onMarkAsRead={vi.fn()} />);

    const articleEl = container.querySelector('[data-article-id="article-1"]');
    expect(articleEl).toBeInTheDocument();
  });

  it('sanitizes summary HTML before rendering (blocks script injection)', () => {
    const article: Article = {
      ...baseArticle,
      summary: '<p>正常なテキスト</p><script>alert("xss")</script>',
    };
    render(<ArticleCard article={article} onMarkAsRead={vi.fn()} />);

    expect(screen.getByText('正常なテキスト')).toBeInTheDocument();
    expect(screen.queryByText(/alert/)).not.toBeInTheDocument();
  });
});
