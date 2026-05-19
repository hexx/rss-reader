import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';

import { ArticleCard } from './components/ArticleCard.js';
import type { Article } from './types.js';

type ArticlesResponse = {
  articles?: Article[];
};

function includesQuery(value: string | null | undefined, query: string): boolean {
  return value?.toLowerCase().includes(query) ?? false;
}

function matchesSearch(article: Article, query: string): boolean {
  if (query.length === 0) {
    return true;
  }

  return (
    includesQuery(article.title, query) ||
    includesQuery(article.summary, query) ||
    includesQuery(article.hatenaSummary, query) ||
    includesQuery(article.url, query) ||
    includesQuery(article.siteUrl, query) ||
    article.bookmarks.some((bookmark) => includesQuery(bookmark.user, query) || includesQuery(bookmark.comment, query))
  );
}

export function App() {
  const [articles, setArticles] = useState<Article[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [showUnreadOnly, setShowUnreadOnly] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [status, setStatus] = useState('読み込み中...');

  const loadArticles = useCallback(async (unreadOnly: boolean) => {
    setStatus(unreadOnly ? '未読記事を読み込み中...' : '記事を読み込み中...');

    const response = await fetch(`/api/articles?unread_only=${unreadOnly ? 'true' : 'false'}`);
    if (!response.ok) {
      throw new Error('記事の読み込みに失敗しました。');
    }

    const payload = (await response.json()) as ArticlesResponse;
    const nextArticles = Array.isArray(payload.articles) ? payload.articles : [];
    setArticles(nextArticles);
    setStatus(
      nextArticles.length === 0
        ? unreadOnly
          ? '未読記事がありません。'
          : '記事がまだありません。'
        : unreadOnly
          ? '未読記事を表示しています。'
          : '最新記事を表示しています。',
    );
  }, []);

  useEffect(() => {
    void loadArticles(showUnreadOnly).catch((error: unknown) => {
      setStatus(error instanceof Error ? error.message : '記事の読み込みに失敗しました。');
    });
  }, [loadArticles, showUnreadOnly]);

  const filteredArticles = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    return articles.filter((article) => matchesSearch(article, normalizedQuery));
  }, [articles, searchQuery]);

  const handleMarkAsRead = useCallback(async (articleId: string) => {
    try {
      const response = await fetch(`/api/articles/${articleId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ isRead: true }),
      });

      if (!response.ok) {
        throw new Error('既読状態の更新に失敗しました。');
      }

      const payload = (await response.json()) as { id?: string; isRead?: boolean };
      setArticles((currentArticles) =>
        currentArticles.map((article) =>
          article.id === articleId ? { ...article, isRead: payload.isRead ?? true } : article,
        ),
      );
      setStatus('既読にしました。');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '既読状態の更新に失敗しました。');
    }
  }, []);

  const handleSync = useCallback(async () => {
    setIsSyncing(true);
    setStatus('同期を開始しました。');

    try {
      const response = await fetch('/api/sync', { method: 'POST' });
      if (!response.ok) {
        throw new Error('同期の開始に失敗しました。');
      }

      setStatus('同期を開始しました。完了後に再読み込みします。');
      await new Promise((resolve) => window.setTimeout(resolve, 4000));
      await loadArticles(showUnreadOnly);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '同期の開始に失敗しました。');
    } finally {
      setIsSyncing(false);
    }
  }, [loadArticles, showUnreadOnly]);

  return (
    <div className="app-shell">
      <div className="workspace">
        <header className="topbar">
          <div>
            <h1>RSS Reader</h1>
            <p>React コンポーネントで記事、要約、はてブコメントを表示します。</p>
          </div>

          <div className="search-toolbar">
            <form
              className="search-form"
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
              }}
            >
              <input
                id="search-input"
                name="query"
                type="search"
                placeholder="記事を絞り込み"
                autoComplete="off"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
              />
              <button type="submit">Search</button>
            </form>
            <label className="search-filter">
              <input
                id="unread-only-toggle"
                type="checkbox"
                checked={showUnreadOnly}
                onChange={(event) => setShowUnreadOnly(event.target.checked)}
              />
              未読のみ表示
            </label>
          </div>

          <button id="sync-button" type="button" onClick={() => void handleSync()} disabled={isSyncing}>
            {isSyncing ? 'Syncing...' : 'Sync'}
          </button>
        </header>

        <main className="layout">
          <section className="panel">
            <p id="status" className="status">
              {status}
            </p>

            <div id="articles" className="cards">
              {filteredArticles.length === 0 ? (
                <p className="empty">
                  {searchQuery.trim().length > 0 ? '検索条件に一致する記事がありません。' : '記事がまだありません。'}
                </p>
              ) : (
                filteredArticles.map((article) => (
                  <ArticleCard key={article.id} article={article} onMarkAsRead={handleMarkAsRead} />
                ))
              )}
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
