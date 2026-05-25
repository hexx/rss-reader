import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import { applyReadStateChange } from './articleState.js';
import { ARTICLE_PAGE_SIZE, buildArticlesUrl, mergeLoadedArticles, shouldShowLoadMore } from './articlePagination.js';
import { ArticleCard } from './components/ArticleCard.js';
import { SourceManager } from './components/SourceManager.js';
import { SourceSwitcher } from './components/SourceSwitcher.js';
import type { Article, Source } from './types.js';

type ArticlesResponse = {
  articles?: Article[];
};

type SearchResponse = {
  aiAnswer?: string;
  error?: string;
  results?: Article[];
};

type SourcesResponse = {
  sources?: Source[];
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
  const [sources, setSources] = useState<Source[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [showUnreadOnly, setShowUnreadOnly] = useState(true);
  const [selectedSourceUrl, setSelectedSourceUrl] = useState<string | undefined>(undefined);
  const [offset, setOffset] = useState(0);
  const [reloadToken, setReloadToken] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [isLoadingArticles, setIsLoadingArticles] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [status, setStatus] = useState('読み込み中...');
  const [aiAnswer, setAiAnswer] = useState('');
  const articleRequestId = useRef(0);

  const refreshArticles = useCallback(() => {
    setOffset(0);
    setHasMore(true);
    setAiAnswer('');
    setReloadToken((currentToken) => currentToken + 1);
  }, []);

  const loadSources = useCallback(async () => {
    const response = await fetch('/api/sources');
    if (!response.ok) {
      throw new Error('購読ソースの読み込みに失敗しました。');
    }

    const payload = (await response.json()) as SourcesResponse;
    setSources(Array.isArray(payload.sources) ? payload.sources : []);
  }, []);

  const loadArticles = useCallback(
    async (unreadOnly: boolean, sourceUrl?: string, nextOffset = 0) => {
      const requestId = articleRequestId.current + 1;
      articleRequestId.current = requestId;
      setIsLoadingArticles(true);
      setAiAnswer('');
      setStatus(
        nextOffset > 0
          ? 'さらに記事を読み込み中...'
          : unreadOnly
            ? '未読記事を読み込み中...'
            : '記事を読み込み中...',
      );

      try {
        const response = await fetch(
          buildArticlesUrl({
            unreadOnly,
            sourceUrl,
            limit: ARTICLE_PAGE_SIZE,
            offset: nextOffset,
          }),
        );
        if (!response.ok) {
          throw new Error('記事の読み込みに失敗しました。');
        }

        const payload = (await response.json()) as ArticlesResponse;
        const nextArticles = Array.isArray(payload.articles) ? payload.articles : [];
        if (articleRequestId.current !== requestId) {
          return;
        }

        setArticles((currentArticles) => mergeLoadedArticles(currentArticles, nextArticles, nextOffset));
        setHasMore(nextArticles.length === ARTICLE_PAGE_SIZE);
        setStatus(
          nextArticles.length === 0
            ? nextOffset > 0
              ? 'これ以上の記事はありません。'
              : unreadOnly
                ? '未読記事がありません。'
                : '記事がまだありません。'
            : nextOffset > 0
              ? 'さらに記事を読み込みました。'
              : unreadOnly
                ? '未読記事を表示しています。'
                : sourceUrl
                  ? '選択したソースの記事を表示しています。'
                  : '最新記事を表示しています。',
        );
      } finally {
        if (articleRequestId.current === requestId) {
          setIsLoadingArticles(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    void loadSources().catch((error: unknown) => {
      setStatus(normalizeError(error, '購読ソースの読み込みに失敗しました。'));
    });
  }, [loadSources]);

  useEffect(() => {
    void loadArticles(showUnreadOnly, selectedSourceUrl, offset).catch((error: unknown) => {
      setStatus(normalizeError(error, '記事の読み込みに失敗しました。'));
    });
  }, [loadArticles, offset, reloadToken, selectedSourceUrl, showUnreadOnly]);

  const filteredArticles = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    return articles.filter((article) => matchesSearch(article, normalizedQuery));
  }, [articles, searchQuery]);

  const handleLocalSearch = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setAiAnswer('');

      if (searchQuery.trim().length === 0) {
        refreshArticles();
        return;
      }

      setStatus('ローカル絞り込みを表示しています。');
    },
    [refreshArticles, searchQuery],
  );

  const handleAiSearch = useCallback(async () => {
    const query = searchQuery.trim();
    if (query.length === 0) {
      refreshArticles();
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
  }, [refreshArticles, searchQuery]);

  const handleMarkAsRead = useCallback(
    async (articleId: string) => {
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
          applyReadStateChange(currentArticles, articleId, payload.isRead ?? true, showUnreadOnly),
        );
        setStatus('既読にしました。');
      } catch (error) {
        setStatus(normalizeError(error, '既読状態の更新に失敗しました。'));
      }
    },
    [showUnreadOnly],
  );

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
      refreshArticles();
    } catch (error) {
      setStatus(normalizeError(error, '同期の開始に失敗しました。'));
    } finally {
      setIsSyncing(false);
    }
  }, [refreshArticles]);

  const handleAddSubscription = useCallback(
    async (siteUrl: string) => {
      const response = await fetch('/api/subscriptions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ siteUrl }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || '購読の追加に失敗しました。');
      }

      await loadSources();
      refreshArticles();
    },
    [loadSources, refreshArticles],
  );

  const handleRemoveSubscription = useCallback(
    async (siteUrl: string) => {
      const response = await fetch('/api/subscriptions', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ siteUrl }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || '購読解除に失敗しました。');
      }

      const nextSelectedSourceUrl = selectedSourceUrl === siteUrl ? undefined : selectedSourceUrl;
      if (nextSelectedSourceUrl !== selectedSourceUrl) {
        setSelectedSourceUrl(nextSelectedSourceUrl);
      }

      await loadSources();
      refreshArticles();
    },
    [loadSources, refreshArticles, selectedSourceUrl],
  );

  const handleSelectSource = useCallback(
    (siteUrl?: string) => {
      setSelectedSourceUrl(siteUrl);
      refreshArticles();
    },
    [refreshArticles],
  );

  const handleLoadMore = useCallback(() => {
    setOffset((currentOffset) => currentOffset + ARTICLE_PAGE_SIZE);
  }, []);

  const showAllSelected = selectedSourceUrl === undefined;
  const showLoadMoreButton = shouldShowLoadMore(hasMore, searchQuery, aiAnswer);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <SourceManager
          onAddSubscription={handleAddSubscription}
          onRemoveSubscription={handleRemoveSubscription}
          sources={sources}
        />
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div>
            <h1>RSS Reader</h1>
            <p>React コンポーネントで記事、要約、はてブコメントを表示します。</p>
          </div>

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
                  onChange={(event) => {
                    setShowUnreadOnly(event.target.checked);
                    refreshArticles();
                  }}
                />
                未読のみ表示
              </label>
            </div>

            <button id="sync-button" type="button" onClick={() => void handleSync()} disabled={isSyncing}>
              {isSyncing ? 'Syncing...' : 'Sync'}
            </button>
          </div>
        </header>

        <SourceSwitcher
          onSelectSource={handleSelectSource}
          selectedSourceUrl={selectedSourceUrl}
          sources={sources}
        />

        <main className="layout">
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
                  {searchQuery.trim().length > 0
                    ? '検索条件に一致する記事がありません。'
                    : showAllSelected
                      ? '記事がまだありません。'
                      : '選択したソースの記事がまだありません。'}
                </p>
              ) : (
                filteredArticles.map((article) => (
                  <ArticleCard key={article.id} article={article} onMarkAsRead={handleMarkAsRead} />
                ))
              )}
            </div>

            {showLoadMoreButton ? (
              <div style={{ marginTop: '1.5rem', textAlign: 'center' }}>
                <button type="button" onClick={() => void handleLoadMore()} disabled={isLoadingArticles}>
                  {isLoadingArticles ? '読み込み中...' : 'さらに読み込む'}
                </button>
              </div>
            ) : null}
          </section>
        </main>
      </div>
    </div>
  );
}
