import { useCallback, useState, type FormEvent } from 'react';

import type { Source } from '../types.js';

type SourceManagerProps = {
  onAddSubscription: (siteUrl: string) => Promise<void>;
  onRemoveSubscription: (siteUrl: string) => Promise<void>;
  sources: Source[];
};

function normalizeError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function SourceManager({
  onAddSubscription,
  onRemoveSubscription,
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
          {sources.length === 0 ? (
            <li>
              <p className="empty">購読ソースがまだありません。</p>
            </li>
          ) : (
            sources.map((source) => (
              <li key={source.id} className="source-row">
                <div className="source-item source-item--static" title={source.siteUrl}>
                  <span className="source-item__title">{source.displayTitle}</span>
                  <span className="source-item__count">
                    ({source.unreadCount}/{source.articleCount})
                  </span>
                </div>
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
