import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';

import { ArticleCard } from './components/ArticleCard.js';
import { SourceManager } from './components/SourceManager.js';
import type { Article } from './types.js';

type ArticlesResponse = {
  articles?: Article[];
};

type SearchResponse = {
  aiAnswer?: string;
  error?: string;
  results?: Article[];
};

type Tab = 'articles' | 'sources';

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
    includesQuery(article.content, query) ||
    includesQuery(article.url, query) ||
    includesQuery(article.siteUrl, query) ||
    article.bookmarks.some((bookmark) => includesQuery(bookmark.user, query) || includesQuery(bookmark.comment, query))
  );
}

function normalizeError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function App() {
  const [articles, setArticles] = useState<Article[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [showUnreadOnly, setShowUnreadOnly] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [status, setStatus] = useState('読み込み中...');
  const [aiAnswer, setAiAnswer] = useState('');
  const [activeTab, setActiveTab] = useState<Tab>('articles');

  const loadArticles = useCallback(async (unreadOnly: boolean) => {
    setAiAnswer('');
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
      setStatus(normalizeError(error, '記事の読み込みに失敗しました。'));
    });
  }, [loadArticles, showUnreadOnly]);

  const filteredArticles = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    return articles.filter((article) => matchesSearch(article, normalizedQuery));
  }, [articles, searchQuery]);

  const handleLocalSearch = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      try {
        await loadArticles(showUnreadOnly);
      } catch (error) {
        setStatus(normalizeError(error, '記事の読み込みに失敗しました。'));
      }
    },
    [loadArticles, showUnreadOnly],
  );

  const handleAiSearch = useCallback(async () => {
    const query = searchQuery.trim();
    if (query.length === 0) {
      await loadArticles(showUnreadOnly).catch((error: unknown) => {
        setStatus(normalizeError(error, '記事の読み込みに失敗しました。'));
      });
      return;
    }

    setStatus('AI検索中...');

    try {
      const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      const payload = (await response.json().catch(() => ({}))) as SearchResponse;
      if (!response.ok) {
        throw new Error(payload.error || '検索に失敗しました。');
      }

      const nextArticles = Array.isArray(payload.results) ? payload.results : [];
      setArticles(nextArticles);
      setAiAnswer(typeof payload.aiAnswer === 'string' ? payload.aiAnswer : '');
      setStatus(nextArticles.length === 0 ? '検索結果がありません。' : 'AI検索結果を表示しています。');
    } catch (error) {
      setAiAnswer('');
      setStatus(normalizeError(error, '検索に失敗しました。'));
    }
  }, [loadArticles, searchQuery, showUnreadOnly]);

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
      setStatus(normalizeError(error, '既読状態の更新に失敗しました。'));
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
      setStatus(normalizeError(error, '同期の開始に失敗しました。'));
    } finally {
      setIsSyncing(false);
    }
  }, [loadArticles, showUnreadOnly]);

  const refreshArticles = useCallback(async () => {
    await loadArticles(showUnreadOnly);
  }, [loadArticles, showUnreadOnly]);

  return (
    <div className="app-shell">
      <div className="workspace">
        <header className="topbar">
          <div className="topbar__main">
            <div>
              <h1>RSS Reader</h1>
              <p>React コンポーネントで記事、要約、はてブコメントを表示します。</p>
            </div>

            <div className="tabs" role="tablist" aria-label="画面切り替え">
              <button
                type="button"
                className={`tab-button ${activeTab === 'articles' ? 'is-active' : ''}`}
                aria-pressed={activeTab === 'articles'}
                onClick={() => setActiveTab('articles')}
              >
                記事一覧
              </button>
              <button
                type="button"
                className={`tab-button ${activeTab === 'sources' ? 'is-active' : ''}`}
                aria-pressed={activeTab === 'sources'}
                onClick={() => setActiveTab('sources')}
              >
                購読設定
              </button>
            </div>
          </div>

          {activeTab === 'articles' ? (
            <div className="topbar__actions">
              <div className="search-toolbar">
                <form className="search-form" onSubmit={handleLocalSearch}>
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
                  <button type="button" onClick={() => void handleAiSearch()}>
                    AIで検索
                  </button>
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
            </div>
          ) : null}
        </header>

        <main className="layout">
          {activeTab === 'articles' ? (
            <section className="panel">
              <p id="status" className="status">
                {status}
              </p>

              {aiAnswer.trim().length > 0 ? (
                <div className="ai-answer">
                  <div className="ai-answer__text">{aiAnswer}</div>
                </div>
              ) : null}

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
          ) : (
            <SourceManager onChange={refreshArticles} />
          )}
        </main>
      </div>
    </div>
  );
}
