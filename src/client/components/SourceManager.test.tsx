import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { Source } from '../types.js';
import { SourceManager } from './SourceManager.js';

const sources: Source[] = [
  {
    articleCount: 5,
    displayTitle: 'Example Feed',
    id: 'source-1',
    siteUrl: 'https://example.com/feed.xml',
    title: 'Example Feed',
    unreadCount: 2,
  },
  {
    articleCount: 0,
    displayTitle: 'Empty Blog',
    id: 'source-2',
    siteUrl: 'https://empty.example/rss',
    title: 'Empty Blog',
    unreadCount: 0,
  },
];

describe('SourceManager', () => {
  it('renders the header', () => {
    render(
      <SourceManager
        onAddSubscription={vi.fn()}
        onRemoveSubscription={vi.fn()}
        sources={[]}
      />,
    );

    expect(screen.getByText('購読設定')).toBeInTheDocument();
    expect(screen.getByText('RSSソースを追加・管理します')).toBeInTheDocument();
  });

  it('shows the input field and add button', () => {
    render(
      <SourceManager
        onAddSubscription={vi.fn()}
        onRemoveSubscription={vi.fn()}
        sources={[]}
      />,
    );

    expect(screen.getByPlaceholderText(/ブログ・サイトのURL/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '追加' })).toBeInTheDocument();
  });

  it('shows skeleton when loading', () => {
    const { container } = render(
      <SourceManager
        onAddSubscription={vi.fn()}
        onRemoveSubscription={vi.fn()}
        sources={[]}
        isLoading
      />,
    );

    // Skeleton コンポーネントは data-slot="skeleton" 属性を持つ
    const skeletons = container.querySelectorAll('[data-slot="skeleton"]');
    expect(skeletons.length).toBeGreaterThanOrEqual(3);
  });

  it('shows empty state when there are no sources', () => {
    render(
      <SourceManager
        onAddSubscription={vi.fn()}
        onRemoveSubscription={vi.fn()}
        sources={[]}
      />,
    );

    expect(screen.getByText('購読ソースがありません')).toBeInTheDocument();
    expect(screen.getByText(/RSSフィードを追加してください/)).toBeInTheDocument();
  });

  it('lists sources with their details', () => {
    render(
      <SourceManager
        onAddSubscription={vi.fn()}
        onRemoveSubscription={vi.fn()}
        sources={sources}
      />,
    );

    expect(screen.getByText('Example Feed')).toBeInTheDocument();
    expect(screen.getByText('https://example.com/feed.xml')).toBeInTheDocument();
    expect(screen.getByText('Empty Blog')).toBeInTheDocument();

    // 未読数バッジ
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('shows the footer with source count', () => {
    render(
      <SourceManager
        onAddSubscription={vi.fn()}
        onRemoveSubscription={vi.fn()}
        sources={sources}
      />,
    );

    expect(screen.getByText('2 件のフィードを購読中')).toBeInTheDocument();
  });

  it('calls onAddSubscription with the URL on form submit', async () => {
    const onAddSubscription = vi.fn();
    const user = userEvent.setup();

    render(
      <SourceManager
        onAddSubscription={onAddSubscription}
        onRemoveSubscription={vi.fn()}
        sources={sources}
      />,
    );

    const input = screen.getByPlaceholderText(/ブログ・サイトのURL/);
    await user.type(input, 'https://new.example/feed');
    await user.click(screen.getByRole('button', { name: '追加' }));

    expect(onAddSubscription).toHaveBeenCalledWith('https://new.example/feed');
  });

  it('validates empty URL on form submit', async () => {
    const onAddSubscription = vi.fn();

    render(
      <SourceManager
        onAddSubscription={onAddSubscription}
        onRemoveSubscription={vi.fn()}
        sources={sources}
      />,
    );

    // required 属性によるネイティブバリデーションをバイパスするため、
    // input に空白を入力してから form を submit する
    // （trim() で空になるため handleSubmit 内の validation が発動する）
    const input = screen.getByPlaceholderText(/ブログ・サイトのURL/) as HTMLInputElement;
    input.value = '   '; // 空白のみ

    const form = screen.getByRole('button', { name: '追加' }).closest('form')!;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    expect(await screen.findByText('購読URLを入力してください。')).toBeInTheDocument();
    expect(onAddSubscription).not.toHaveBeenCalled();
  });

  it('calls onRemoveSubscription when the remove button is clicked', async () => {
    const onRemoveSubscription = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(
      <SourceManager
        onAddSubscription={vi.fn()}
        onRemoveSubscription={onRemoveSubscription}
        sources={sources}
      />,
    );

    // 各ソースの削除ボタン（購読解除）をクリック
    const removeButtons = screen.getAllByRole('button', { name: '購読解除' });
    // TooltipTrigger の二重 button の内側を選択
    const innerRemoveRemove = removeButtons.find((btn) => btn.getAttribute('data-slot') === 'button');
    expect(innerRemoveRemove).not.toBeNull();

    await user.click(innerRemoveRemove!);

    expect(onRemoveSubscription).toHaveBeenCalledWith('https://example.com/feed.xml');
  });

  it('calls onSelectSource when a source item is clicked', async () => {
    const onSelectSource = vi.fn();
    const user = userEvent.setup();

    render(
      <SourceManager
        onAddSubscription={vi.fn()}
        onRemoveSubscription={vi.fn()}
        sources={sources}
        onSelectSource={onSelectSource}
      />,
    );

    // 最初のソースのソース要素（role="button" の div）をクリック
    const sourceItem = screen.getByText('Example Feed').closest('[role="button"]');
    expect(sourceItem).not.toBeNull();

    await user.click(sourceItem!);

    expect(onSelectSource).toHaveBeenCalledWith('https://example.com/feed.xml');
  });

  it('calls onSelectSource with undefined when an already selected source is clicked', async () => {
    const onSelectSource = vi.fn();
    const user = userEvent.setup();

    render(
      <SourceManager
        onAddSubscription={vi.fn()}
        onRemoveSubscription={vi.fn()}
        sources={sources}
        onSelectSource={onSelectSource}
        selectedSourceUrl="https://example.com/feed.xml"
      />,
    );

    const sourceItem = screen.getByText('Example Feed').closest('[role="button"]');
    expect(sourceItem).not.toBeNull();

    await user.click(sourceItem!);

    // 選択済みのソースを再度クリック → undefined（選択解除）
    expect(onSelectSource).toHaveBeenCalledWith(undefined);
  });

  it('calls onSelectSource on Enter key press', async () => {
    const onSelectSource = vi.fn();
    const user = userEvent.setup();

    render(
      <SourceManager
        onAddSubscription={vi.fn()}
        onRemoveSubscription={vi.fn()}
        sources={sources}
        onSelectSource={onSelectSource}
      />,
    );

    const sourceItem = screen.getByText('Example Feed').closest('[role="button"]');
    expect(sourceItem).not.toBeNull();

    sourceItem!.focus();
    await user.keyboard('{Enter}');

    expect(onSelectSource).toHaveBeenCalledWith('https://example.com/feed.xml');
  });

  it('stops propagation when clicking the remove button (prevents source selection)', async () => {
    const onSelectSource = vi.fn();
    const onRemoveSubscription = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(
      <SourceManager
        onAddSubscription={vi.fn()}
        onRemoveSubscription={onRemoveSubscription}
        sources={sources}
        onSelectSource={onSelectSource}
      />,
    );

    const removeButtons = screen.getAllByRole('button', { name: '購読解除' });
    const innerRemove = removeButtons.find((btn) => btn.getAttribute('data-slot') === 'button');
    expect(innerRemove).not.toBeNull();

    await user.click(innerRemove!);

    // onRemoveSubscription は呼ばれるが、onSelectSource は呼ばれない（stopPropagation）
    expect(onRemoveSubscription).toHaveBeenCalled();
    expect(onSelectSource).not.toHaveBeenCalled();
  });

  it('shows an error message when add fails', async () => {
    const onAddSubscription = vi.fn().mockRejectedValue(new Error('フィードが見つかりません'));
    const user = userEvent.setup();

    render(
      <SourceManager
        onAddSubscription={onAddSubscription}
        onRemoveSubscription={vi.fn()}
        sources={sources}
      />,
    );

    const input = screen.getByPlaceholderText(/ブログ・サイトのURL/);
    await user.type(input, 'https://invalid.example');
    await user.click(screen.getByRole('button', { name: '追加' }));

    expect(await screen.findByText('フィードが見つかりません')).toBeInTheDocument();
  });
});
