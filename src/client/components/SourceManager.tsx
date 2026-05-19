import { useCallback, useState, type FormEvent } from 'react';

import type { Source } from '../types.js';

type SourceManagerProps = {
  onAddSubscription: (siteUrl: string) => Promise<void>;
  onRemoveSubscription: (siteUrl: string) => Promise<void>;
  onSelectSource: (siteUrl?: string) => void;
  selectedSourceUrl: string | undefined;
  sources: Source[];
};

function normalizeError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function SourceManager({
  onAddSubscription,
  onRemoveSubscription,
  onSelectSource,
  selectedSourceUrl,
  sources,
}: SourceManagerProps) {
  const [siteUrl, setSiteUrl] = useState('');
  const [status, setStatus] = useState('購読ソースを表示しています。');

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const normalizedSiteUrl = siteUrl.trim();
      if (normalizedSiteUrl.length === 0) {
        setStatus('購読URLを入力してください。');
        return;
      }

      try {
        await onAddSubscription(normalizedSiteUrl);
        setSiteUrl('');
        setStatus('購読を追加しました。');
      } catch (error) {
        setStatus(normalizeError(error, '購読の追加に失敗しました。'));
      }
    },
    [onAddSubscription, siteUrl],
  );

  const handleRemove = useCallback(
    async (targetSiteUrl: string) => {
      try {
        await onRemoveSubscription(targetSiteUrl);
        setStatus('購読を解除しました。');
      } catch (error) {
        setStatus(normalizeError(error, '購読解除に失敗しました。'));
      }
    },
    [onRemoveSubscription],
  );

  return (
    <div className="source-manager">
      <div className="sidebar__header">
        <h2>購読設定</h2>
        <p>RSSソースを追加・解除します。</p>
      </div>

      <form className="search-form subscription-form" onSubmit={handleSubmit}>
        <input
          id="subscription-input"
          name="siteUrl"
          type="url"
          placeholder="RSSのURLを追加"
          autoComplete="url"
          required
          value={siteUrl}
          onChange={(event) => setSiteUrl(event.target.value)}
        />
        <button type="submit">追加</button>
      </form>

      <p className="status">{status}</p>

      <nav aria-label="RSS sources">
        <ul className="sources-list">
          <li className="source-row source-row--all">
            <button
              type="button"
              className={`source-item ${selectedSourceUrl === undefined ? 'is-active' : ''}`}
              onClick={() => onSelectSource(undefined)}
            >
              すべての記事
            </button>
          </li>
          {sources.length === 0 ? (
            <li>
              <p className="empty">購読ソースがまだありません。</p>
            </li>
          ) : (
            sources.map((source) => (
              <li key={source.id} className="source-row">
                <button
                  type="button"
                  className={`source-item ${selectedSourceUrl === source.siteUrl ? 'is-active' : ''}`}
                  title={source.siteUrl}
                  onClick={() => onSelectSource(source.siteUrl)}
                >
                  {source.displayTitle} ({source.unreadCount}/{source.articleCount})
                </button>
                <button
                  type="button"
                  className="source-remove"
                  title={source.siteUrl}
                  onClick={() => void handleRemove(source.siteUrl)}
                >
                  解除
                </button>
              </li>
            ))
          )}
        </ul>
      </nav>
    </div>
  );
}
