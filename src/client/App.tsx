import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
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
} from 'lucide-react';
import { useCallback, useMemo, useState, type FormEvent } from 'react';

import { applyReadStateChange } from './articleState.js';
import { shouldShowLoadMore } from './articlePagination.js';
import { ArticleCard } from './components/ArticleCard.js';
import { SourceManager } from './components/SourceManager.js';
import { useArticles } from './hooks/useArticles.js';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts.js';
import { useSources } from './hooks/useSources.js';
import { useSubscriptions } from './hooks/useSubscriptions.js';
import { useSync } from './hooks/useSync.js';
import type { Article, ArticleSortDirection } from './types.js';
import { normalizeError, type Status } from './utils/status.js';

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

function ArticleCardSkeleton() {
  return (
    <div className="rounded-lg border p-6 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-1 flex-col gap-2">
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

function StatusAlert({ status }: { status: Status }) {
  const icon = (() => {
    switch (status.kind) {
      case 'error':
        return <AlertCircle className="size-4" />;
      case 'success':
        return <CheckCircle2 className="size-4" />;
      case 'loading':
        return <Loader2 className="size-4 animate-spin" />;
    }
  })();

  return (
    <Alert
      variant={status.kind === 'error' ? 'destructive' : 'default'}
      className="mb-4"
      role={status.kind === 'error' ? 'alert' : 'status'}
      aria-live={status.kind === 'error' ? 'assertive' : 'polite'}
      aria-atomic="true"
    >
      {icon}
      <AlertDescription>{status.message}</AlertDescription>
    </Alert>
  );
}

export function App() {
  const [searchQuery, setSearchQuery] = useState('');
  const [showUnreadOnly, setShowUnreadOnly] = useState(true);
  const [selectedSourceUrl, setSelectedSourceUrl] = useState<string | undefined>(undefined);
  const [sortOrder, setSortOrder] = useState<ArticleSortDirection>('asc');
  const [sheetOpen, setSheetOpen] = useState(false);

  const sources = useSources();
  const { articles, hasMore, isLoading: isLoadingArticles, loadMore, refresh, setArticles, status: articlesStatus } = useArticles({
    selectedSourceUrl,
    showUnreadOnly,
    sortOrder,
  });

  const refreshAll = useCallback(() => {
    sources.reload().catch((error: unknown) => {
      // useSources 側で status が更新されるため、ここでは何もしない
      void normalizeError(error, '購読ソースの読み込みに失敗しました。');
    });
    refresh();
  }, [refresh, sources]);

  const subscriptions = useSubscriptions({ onAfterChange: refreshAll });
  const sync = useSync({ onAfterSync: refresh });

  const [readStateStatus, setReadStateStatus] = useState<Status | null>(null);

  const handleMarkAsRead = useCallback(
    async (articleId: string) => {
      const previousArticles = articles;

      // Optimistic UI: 即座に既読化 / 未読のみモードでは削除。
      // unreadCount の減算は sources.reload() 後に再計算されるためここでは行わない。
      setArticles((current) => applyReadStateChange(current, articleId, true, showUnreadOnly));
      setReadStateStatus({ kind: 'loading', message: '既読にしています...' });

      try {
        const response = await fetch(`/api/articles/${articleId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isRead: true }),
        });
        if (!response.ok) {
          throw new Error('既読状態の更新に失敗しました。');
        }
        await sources.reload();
        setReadStateStatus({ kind: 'success', message: '既読にしました。' });
      } catch (error) {
        // 失敗時は optimistic update を巻き戻す
        setArticles(previousArticles);
        setReadStateStatus({
          kind: 'error',
          message: normalizeError(error, '既読状態の更新に失敗しました。'),
        });
      }
    },
    [articles, showUnreadOnly, sources],
  );

  useKeyboardShortcuts(articles, { onMarkAsRead: (id) => void handleMarkAsRead(id) });

  const handleAddSubscription = useCallback(
    async (siteUrl: string) => {
      await subscriptions.add(siteUrl);
    },
    [subscriptions],
  );

  const handleRemoveSubscription = useCallback(
    async (siteUrl: string) => {
      await subscriptions.remove(siteUrl);
      if (selectedSourceUrl === siteUrl) {
        setSelectedSourceUrl(undefined);
      }
    },
    [selectedSourceUrl, subscriptions],
  );

  const handleSelectSource = useCallback(
    (siteUrl?: string) => {
      setSelectedSourceUrl(siteUrl);
      refresh();
      setSheetOpen(false);
    },
    [refresh],
  );

  const handleLoadMore = useCallback(() => {
    loadMore();
  }, [loadMore]);

  const filteredArticles = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    return articles.filter((article) => matchesSearch(article, normalizedQuery));
  }, [articles, searchQuery]);

  const handleLocalSearch = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (searchQuery.trim().length === 0) {
        refresh();
      }
    },
    [refresh, searchQuery],
  );

  const showAllSelected = selectedSourceUrl === undefined;
  const showLoadMoreButton = shouldShowLoadMore(hasMore, searchQuery);
  const totalUnreadCount = useMemo(
    () => sources.sources.reduce((sum, source) => sum + source.unreadCount, 0),
    [sources.sources],
  );

  const displayedStatus: Status | null =
    readStateStatus ?? subscriptions.error ?? sync.status ?? articlesStatus ?? sources.status;

  return (
    <TooltipProvider>
      <div className="flex h-[100dvh] flex-col w-full overflow-x-hidden">
        <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <div className="flex flex-wrap md:flex-nowrap items-center justify-between gap-3 md:gap-4 px-4 py-3 md:h-16 md:py-0 md:px-6">
            <div className="flex items-center gap-2 md:gap-4">
              <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
                <SheetTrigger render={<Button variant="ghost" size="icon" className="md:hidden" />}>
                  <Menu className="size-5" />
                  <span className="sr-only">メニューを開く</span>
                </SheetTrigger>
                <SheetContent side="left" className="w-80 p-0">
                  <SheetTitle className="sr-only">購読設定</SheetTitle>
                  <SourceManager
                    onAddSubscription={handleAddSubscription}
                    onRemoveSubscription={handleRemoveSubscription}
                    sources={sources.sources}
                    isLoading={sources.isLoading}
                    onSelectSource={handleSelectSource}
                    selectedSourceUrl={selectedSourceUrl}
                  />
                </SheetContent>
              </Sheet>

              <div className="flex items-center gap-2">
                <h1 className="text-lg font-bold tracking-tight md:text-xl">RSS Reader</h1>
                {totalUnreadCount > 0 && (
                  <Badge variant="secondary" className="hidden md:inline-flex">
                    {totalUnreadCount} 未読
                  </Badge>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 md:order-last shrink-0">
              <label className="hidden items-center gap-2 md:flex">
                <Checkbox
                  id="unread-only-toggle"
                  checked={showUnreadOnly}
                  onCheckedChange={(checked) => {
                    setShowUnreadOnly(checked === true);
                    refresh();
                  }}
                />
                <span className="text-sm text-muted-foreground">未読のみ</span>
              </label>
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
                  <ArrowUpDown className="size-4" />
                  <span className="hidden sm:inline ml-1">
                    {sortOrder === 'asc' ? '古い順' : '新しい順'}
                  </span>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuGroup>
                    <DropdownMenuItem
                      onClick={() => {
                        setSortOrder('asc');
                        refresh();
                      }}
                    >
                      古い順
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => {
                        setSortOrder('desc');
                        refresh();
                      }}
                    >
                      新しい順
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void sync.sync()}
                disabled={sync.isSyncing}
              >
                {sync.isSyncing ? (
                  <Loader2 data-icon="inline-start" className="animate-spin" />
                ) : (
                  <RefreshCw data-icon="inline-start" />
                )}
                <span className="hidden sm:inline">同期</span>
              </Button>
            </div>

            <form
              className="flex w-full md:flex-1 items-center gap-2 order-last md:order-none min-w-0"
              onSubmit={handleLocalSearch}
            >
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
            </form>
          </div>
        </header>

        <div className="flex flex-col md:flex-row flex-1 overflow-hidden">
          <aside className="hidden md:block w-80 shrink-0 border-r bg-background/80 backdrop-blur-md overflow-y-auto">
            <SourceManager
              onAddSubscription={handleAddSubscription}
              onRemoveSubscription={handleRemoveSubscription}
              sources={sources.sources}
              isLoading={sources.isLoading}
              onSelectSource={handleSelectSource}
              selectedSourceUrl={selectedSourceUrl}
            />
          </aside>

          <main id="content" tabIndex={-1} className="flex-1 min-h-0 overflow-y-auto">
            <div className="p-4 md:p-6">
              {displayedStatus && <StatusAlert status={displayedStatus} />}

              <div className="grid gap-4">
                {isLoadingArticles && articles.length === 0 ? (
                  <>
                    <ArticleCardSkeleton />
                    <ArticleCardSkeleton />
                    <ArticleCardSkeleton />
                  </>
                ) : filteredArticles.length === 0 ? (
                  <Empty>
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <Search />
                      </EmptyMedia>
                      <EmptyTitle>
                        {searchQuery.trim().length > 0
                          ? '検索条件に一致する記事がありません'
                          : showAllSelected
                            ? '記事がまだありません'
                            : '選択したソースの記事がありません'}
                      </EmptyTitle>
                      <EmptyDescription>
                        {searchQuery.trim().length > 0
                          ? 'キーワードを変更して再度検索してください'
                          : 'RSSフィードを追加して記事を取得しましょう'}
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : (
                  filteredArticles.map((article) => (
                    <ArticleCard
                      key={article.id}
                      article={article}
                      onMarkAsRead={(id) => void handleMarkAsRead(id)}
                    />
                  ))
                )}
              </div>

              {showLoadMoreButton && (
                <div className="mt-6 flex justify-center">
                  <Button variant="outline" onClick={handleLoadMore} disabled={isLoadingArticles}>
                    {isLoadingArticles ? (
                      <>
                        <Loader2 data-icon="inline-start" className="animate-spin" />
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
