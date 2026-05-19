import { useCallback, useEffect, useState, type FormEvent } from 'react';

import type { Source } from '../types.js';

type SourceManagerProps = {
  onChange?: () => Promise<void> | void;
};

type SourcesResponse = {
  sources?: Source[];
};

type MutationResponse = {
  error?: string;
};

function normalizeError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function SourceManager({ onChange }: SourceManagerProps) {
  const [sources, setSources] = useState<Source[]>([]);
  const [siteUrl, setSiteUrl] = useState('');
  const [status, setStatus] = useState('購読ソースを読み込み中...');

  const loadSources = useCallback(async () => {
    setStatus('購読ソースを読み込み中...');

    const response = await fetch('/api/sources');
    if (!response.ok) {
      throw new Error('購読ソースの読み込みに失敗しました。');
    }

    const payload = (await response.json()) as SourcesResponse;
    const nextSources = Array.isArray(payload.sources) ? payload.sources : [];
    setSources(nextSources);
    setStatus(nextSources.length === 0 ? '購読ソースがまだありません。' : '購読ソースを表示しています。');
  }, []);

  useEffect(() => {
    void loadSources().catch((error: unknown) => {
      setStatus(normalizeError(error, '購読ソースの読み込みに失敗しました。'));
    });
  }, [loadSources]);

  const refresh = useCallback(async () => {
    await loadSources();
    await onChange?.();
  }, [loadSources, onChange]);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const normalizedSiteUrl = siteUrl.trim();
      if (normalizedSiteUrl.length === 0) {
        setStatus('購読URLを入力してください。');
        return;
      }

      try {
        const response = await fetch('/api/subscriptions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ siteUrl: normalizedSiteUrl }),
        });
        const payload = (await response.json().catch(() => ({}))) as MutationResponse;
        if (!response.ok) {
          throw new Error(payload.error || '購読の追加に失敗しました。');
        }

        setSiteUrl('');
        setStatus('購読を追加しました。');
        await refresh();
      } catch (error) {
        setStatus(normalizeError(error, '購読の追加に失敗しました。'));
      }
    },
    [refresh, siteUrl],
  );

  const handleRemove = useCallback(
    async (targetSiteUrl: string) => {
      try {
        const response = await fetch('/api/subscriptions', {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ siteUrl: targetSiteUrl }),
        });
        const payload = (await response.json().catch(() => ({}))) as MutationResponse;
        if (!response.ok) {
          throw new Error(payload.error || '購読解除に失敗しました。');
        }

        setStatus('購読を解除しました。');
        await refresh();
      } catch (error) {
        setStatus(normalizeError(error, '購読解除に失敗しました。'));
      }
    },
    [refresh],
  );

  return (
    <section className="panel source-manager">
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
              <li key={source.id}>
                <div className="source-row">
                  <button
                    type="button"
                    className="source-item"
                    title={source.siteUrl}
                    onClick={() => setSiteUrl(source.siteUrl)}
                  >
                    {source.displayTitle} ({source.unreadCount} / {source.articleCount})
                  </button>
                  <button
                    type="button"
                    className="source-remove"
                    title={source.siteUrl}
                    onClick={() => void handleRemove(source.siteUrl)}
                  >
                    解除
                  </button>
                </div>
              </li>
            ))
          )}
        </ul>
      </nav>
    </section>
  );
}
