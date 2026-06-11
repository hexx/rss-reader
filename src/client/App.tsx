import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  AlertCircle,
  ArrowUpDown,
  CheckCircle2,
  Loader2,
  Menu,
  RefreshCw,
  Search,
  Sparkles,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import { applyReadStateChange } from './articleState.js';
import {
  ARTICLE_PAGE_SIZE,
  buildArticlesUrl,
  mergeLoadedArticles,
  shouldShowLoadMore,
} from './articlePagination.js';
import { ArticleCard } from './components/ArticleCard.js';
import { SourceManager } from './components/SourceManager.js';
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
    article.bookmarks.some(
      (bookmark) => includesQuery(bookmark.user, query) || includesQuery(bookmark.comment, query),
    )
  );
}

function normalizeError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function ArticleCardSkeleton() {
  return (
    <div className="rounded-lg border p-6 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2 flex-1">
          <Skeleton className="h-6 w-3/4" />
          <div className="flex gap-2">
            <Skeleton className="h-5 w-20" />
            <Skeleton className="h-5 w-24" />
          </div>
        </div>
        <Skeleton className="h-9 w-20" />
      </div>
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-20 w-full" />
    </div>
  );
}

function StatusAlert({ status }: { status: string }) {
  if (!status) return null;

  const isError = status.includes('失敗') || status.includes('エラー');
  const isSuccess = status.includes('しました') || status.includes('表示しています');

  return (
    <Alert variant={isError ? 'destructive' : 'default'} className="mb-4">
      {isError ? (
        <AlertCircle className="size-4" />
      ) : isSuccess ? (
        <CheckCircle2 className="size-4" />
      ) : (
        <Loader2 className="size-4 animate-spin" />
      )}
      <AlertDescription>{status}</AlertDescription>
    </Alert>
  );
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
  const [isLoadingSources, setIsLoadingSources] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [status, setStatus] = useState('');
  const [aiAnswer, setAiAnswer] = useState('');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const articleRequestId = useRef(0);

  const refreshArticles = useCallback(() => {
    setOffset(0);
    setHasMore(true);
    setAiAnswer('');
    setReloadToken((currentToken) => currentToken + 1);
  }, []);

  const loadSources = useCallback(async () => {
    setIsLoadingSources(true);
    try {
      const response = await fetch('/api/sources');
      if (!response.ok) {
        throw new Error('購読ソースの読み込みに失敗しました。');
      }

      const payload = (await response.json()) as SourcesResponse;
      setSources(Array.isArray(payload.sources) ? payload.sources : []);
    } catch (error) {
      setStatus(normalizeError(error, '購読ソースの読み込みに失敗しました。'));
    } finally {
      setIsLoadingSources(false);
    }
  }, []);

  const loadArticles = useCallback(
    async (unreadOnly: boolean, sourceUrl?: string, nextOffset = 0, sort: 'asc' | 'desc' = 'asc') => {
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
            sort,
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
    void loadArticles(showUnreadOnly, selectedSourceUrl, offset, sortOrder).catch((error: unknown) => {
      setStatus(normalizeError(error, '記事の読み込みに失敗しました。'));
    });
  }, [loadArticles, offset, reloadToken, selectedSourceUrl, showUnreadOnly, sortOrder]);

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
      setSheetOpen(false);
    },
    [refreshArticles],
  );

  const handleLoadMore = useCallback(() => {
    setOffset((currentOffset) => currentOffset + ARTICLE_PAGE_SIZE);
  }, []);

  const showAllSelected = selectedSourceUrl === undefined;
  const showLoadMoreButton = shouldShowLoadMore(hasMore, searchQuery, aiAnswer);

  const totalUnreadCount = sources.reduce((sum, source) => sum + source.unreadCount, 0);

  return (
    <TooltipProvider>
      <div className="flex h-[100dvh] flex-col w-full overflow-x-hidden">
        {/* Header */}
        <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <div className="flex flex-wrap md:flex-nowrap items-center justify-between gap-3 md:gap-4 px-4 py-3 md:h-16 md:py-0 md:px-6">
            {/* Left side: Mobile menu + Logo */}
            <div className="flex items-center gap-2 md:gap-4">
              {/* Mobile menu */}
              <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
                <SheetTrigger
                  render={
                    <Button variant="ghost" size="icon" className="md:hidden" />
                  }
                >
                  <Menu className="size-5" />
                  <span className="sr-only">メニューを開く</span>
                </SheetTrigger>
                <SheetContent side="left" className="w-80 p-0">
                  <SourceManager
                    onAddSubscription={handleAddSubscription}
                    onRemoveSubscription={handleRemoveSubscription}
                    sources={sources}
                    isLoading={isLoadingSources}
                    onSelectSource={handleSelectSource}
                    selectedSourceUrl={selectedSourceUrl}
                  />
                </SheetContent>
              </Sheet>

              {/* Logo */}
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-bold tracking-tight md:text-xl">RSS Reader</h1>
                {totalUnreadCount > 0 && (
                  <Badge variant="secondary" className="hidden md:inline-flex">
                    {totalUnreadCount} 未読
                  </Badge>
                )}
              </div>
            </div>

            {/* Right side: Actions */}
            <div className="flex flex-wrap items-center gap-2 md:order-last shrink-0">
              <label className="hidden items-center gap-2 md:flex">
                <Checkbox
                  id="unread-only-toggle"
                  checked={showUnreadOnly}
                  onCheckedChange={(checked) => {
                    setShowUnreadOnly(checked === true);
                    refreshArticles();
                  }}
                />
                <span className="text-sm text-muted-foreground">未読のみ</span>
              </label>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button variant="outline" size="sm" />
                  }
                >
                  <ArrowUpDown className="size-4" />
                  <span className="hidden sm:inline ml-1">{sortOrder === 'asc' ? '古い順' : '新しい順'}</span>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem onClick={() => {
                    setSortOrder('asc');
                    refreshArticles();
                  }}>
                    古い順
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => {
                    setSortOrder('desc');
                    refreshArticles();
                  }}>
                    新しい順
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleSync()}
                disabled={isSyncing}
              >
                {isSyncing ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
                <span className="hidden sm:inline ml-1">同期</span>
              </Button>
            </div>

            {/* Search - order-last on mobile */}
            <form className="flex w-full md:flex-1 items-center gap-2 order-last md:order-none min-w-0" onSubmit={handleLocalSearch}>
              <div className="relative flex-1 max-w-md min-w-0">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                <Input
                  id="search-input"
                  name="query"
                  type="search"
                  placeholder="記事を検索..."
                  autoComplete="off"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  className="pl-9"
                />
              </div>
              <Button type="submit" variant="secondary" size="sm">
                検索
              </Button>
              <Button type="button" size="sm" onClick={() => void handleAiSearch()} className="hidden sm:inline-flex">
                <Sparkles className="size-4 mr-1" />
                AI検索
              </Button>
            </form>
          </div>
        </header>

        {/* Main content */}
        <div className="flex flex-col md:flex-row flex-1 overflow-hidden">
          {/* Desktop sidebar - hidden on mobile */}
          <aside className="hidden md:block w-80 shrink-0 border-r bg-background/80 backdrop-blur-md overflow-y-auto">
            <SourceManager
              onAddSubscription={handleAddSubscription}
              onRemoveSubscription={handleRemoveSubscription}
              sources={sources}
              isLoading={isLoadingSources}
              onSelectSource={handleSelectSource}
              selectedSourceUrl={selectedSourceUrl}
            />
          </aside>

          {/* Content area */}
          <main className="flex-1 min-h-0 overflow-y-auto">
            <div className="p-4 md:p-6">
              {/* Status */}
              {status && <StatusAlert status={status} />}

              {/* AI Answer */}
              {aiAnswer.trim().length > 0 && (
                <Alert className="mb-4 border-primary/50 bg-primary/5">
                  <Sparkles className="size-4 text-primary" />
                  <AlertDescription className="prose prose-sm max-w-none dark:prose-invert">
                    {aiAnswer}
                  </AlertDescription>
                </Alert>
              )}

              {/* Articles */}
              <div className="grid gap-4">
                {isLoadingArticles && articles.length === 0 ? (
                  <>
                    <ArticleCardSkeleton />
                    <ArticleCardSkeleton />
                    <ArticleCardSkeleton />
                  </>
                ) : filteredArticles.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-center">
                    <Search className="size-12 text-muted-foreground/50 mb-4" />
                    <p className="text-lg font-medium text-muted-foreground">
                      {searchQuery.trim().length > 0
                        ? '検索条件に一致する記事がありません'
                        : showAllSelected
                          ? '記事がまだありません'
                          : '選択したソースの記事がありません'}
                    </p>
                    <p className="text-sm text-muted-foreground/70 mt-1">
                      {searchQuery.trim().length > 0
                        ? 'キーワードを変更して再度検索してください'
                        : 'RSSフィードを追加して記事を取得しましょう'}
                    </p>
                  </div>
                ) : (
                  filteredArticles.map((article) => (
                    <ArticleCard key={article.id} article={article} onMarkAsRead={handleMarkAsRead} />
                  ))
                )}
              </div>

              {/* Load more */}
              {showLoadMoreButton && (
                <div className="mt-6 flex justify-center">
                  <Button
                    variant="outline"
                    onClick={() => void handleLoadMore()}
                    disabled={isLoadingArticles}
                  >
                    {isLoadingArticles ? (
                      <>
                        <Loader2 className="size-4 animate-spin mr-1" />
                        読み込み中...
                      </>
                    ) : (
                      'さらに読み込む'
                    )}
                  </Button>
                </div>
              )}
            </div>
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}
