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
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  AlertCircle,
  ArrowUpDown,
  CheckCircle2,
  Inbox,
  Loader2,
  Menu,
  RefreshCw,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { applyReadStateChange } from './articleState.js';
import { ArticleCard } from './components/ArticleCard.js';
import { SourceManager } from './components/SourceManager.js';
import { useArticles } from './hooks/useArticles.js';
import { useLatestRef } from './hooks/useLatestRef.js';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts.js';
import { useSources } from './hooks/useSources.js';
import { useSubscriptions } from './hooks/useSubscriptions.js';
import { useSync } from './hooks/useSync.js';
import type { ArticleSortDirection } from './types.js';
import { normalizeError } from './utils/status.js';
import type { Status } from './utils/status.js';

/** 既読化ステータスの自動クリアまでの時間（ミリ秒）。 */
const READ_STATE_STATUS_DURATION_MS = 4000;

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
      case 'error': {
        return <AlertCircle className="size-4" />;
      }
      case 'success': {
        return <CheckCircle2 className="size-4" />;
      }
      case 'loading': {
        return <Loader2 className="size-4 animate-spin" />;
      }
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
  const [showUnreadOnly, setShowUnreadOnly] = useState(true);
  const [selectedSourceUrl, setSelectedSourceUrl] = useState<string | undefined>();
  const [sortOrder, setSortOrder] = useState<ArticleSortDirection>('asc');
  const [sheetOpen, setSheetOpen] = useState(false);

  const sources = useSources();
  const { articles, hasMore, isLoading: isLoadingArticles, loadMore, refresh, setArticles, status: articlesStatus } = useArticles({
    selectedSourceUrl,
    showUnreadOnly,
    sortOrder,
  });

  const refreshAll = useCallback(() => {
    // useSources 側で status が更新されるため、ここではエラー処理しない。
    // reload() は内部で reject を握り潰すため、追加の catch は不要。
    void sources.reload();
    refresh();
  }, [refresh, sources]);

  const subscriptions = useSubscriptions({ onAfterChange: refreshAll });
  const sync = useSync({ onAfterSync: refresh });

  const [readStateStatus, setReadStateStatus] = useState<Status | null>(null);
  // 既読化リクエストが進行中の記事 ID。`m` 連打等で同一記事が二重発火した際の
  // 二重減算・二重 PATCH を防ぐ（ADR 0007）。
  const inFlightReadsRef = useRef(new Set<string>());
  // ステータス自動クリア用タイマーの ID（アンマウント時のクリーンアップ用）。
  const readStateTimerRef = useRef<number | null>(null);
  // アンマウント後の非同期継続（PATCH 完了後の status 更新等）を防ぐ。
  // 初期値 false（マウント effect 実行後に true になる。StrictMode の二重マウントでも安全）。
  const mountedRef = useRef(false);
  // ロールバック時に「現在の」フィルタ値を使うための最新値 ref（クロージャの陳腐化対策）。
  const filterParamsRef = useLatestRef({ selectedSourceUrl, showUnreadOnly, sortOrder });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // 既読化ステータスは成功/エラーの場合、一定時間で自動的に消す。
  // 残留したままにすると displayedStatus の優先順位（先頭）で後続のステータスを
  // 隠し続けるため。ローディングは処理の完了で必ず置き換わるため自動クリアしない
  // （時間経過で「処理中」表示が消えると進行中なのか不明瞭になる）。
  const showReadStateStatus = useCallback((nextStatus: Status) => {
    if (!mountedRef.current) {
      return;
    }
    setReadStateStatus(nextStatus);
    if (nextStatus.kind === 'loading') {
      return;
    }
    if (readStateTimerRef.current !== null) {
      window.clearTimeout(readStateTimerRef.current);
    }
    const timerId = window.setTimeout(() => {
      // 自分自身のタイマーだけを破棄する（後続の showReadStateStatus が
      // 登録したタイマーの ID を壊さない）。
      if (readStateTimerRef.current === timerId) {
        readStateTimerRef.current = null;
      }
      setReadStateStatus((current) => (current === nextStatus ? null : current));
    }, READ_STATE_STATUS_DURATION_MS);
    readStateTimerRef.current = timerId;
  }, []);

  useEffect(() => {
    // アンマウント後にタイマーが発火して setState しないようクリアする
    return () => {
      if (readStateTimerRef.current !== null) {
        window.clearTimeout(readStateTimerRef.current);
        readStateTimerRef.current = null;
      }
    };
  }, []);

  const handleMarkAsRead = useCallback(
    async (articleId: string) => {
      const target = articles.find((article) => article.id === articleId);
      // 既に既読、またはリクエスト進行中の記事はスキップ（二重減算ガード）。
      if (!target || target.isRead || inFlightReadsRef.current.has(articleId)) {
        return;
      }
      inFlightReadsRef.current.add(articleId);

      const previousArticles = articles;

      // Optimistic UI: 即座に既読化 / 未読のみモードでは削除し、
      // 該当ソースの未読数も楽観的に -1 する（ヘッダーの総未読数はキャッシュから派生するため自動で追従する）。
      // PATCH 成功後の sources.reload() はサイレントにサーバ真値と突き合わせる（ADR 0007）。
      const previousSources = sources.decrementUnreadCount(target.siteUrl);
      setArticles((current) => applyReadStateChange(current, articleId, true, showUnreadOnly));
      showReadStateStatus({ kind: 'loading', message: '既読にしています...' });

      try {
        const response = await fetch(`/api/articles/${articleId}`, {
          body: JSON.stringify({ isRead: true }),
          headers: { 'Content-Type': 'application/json' },
          method: 'PATCH',
        });
        if (!response.ok) {
          throw new Error('既読状態の更新に失敗しました。');
        }
        await sources.reload();
        showReadStateStatus({ kind: 'success', message: '既読にしました。' });
      } catch (error) {
        if (!mountedRef.current) {
          // アンマウント後のロールバックは UI に反映されないため行わない
          // （inFlightReadsRef のクリーンアップは finally で実行される）
          return;
        }
        // 失敗時は optimistic update を巻き戻す（記事リストと未読数の両方）。
        // リスト全体を取得時点のスナップショットへ戻すと、その間に読み込んだ
        // 追加ページ等の更新が失われるため、対象記事のみを巻き戻す。
        // フィルタ・並び順はロールバック実行時点の値（ref）を使う。
        const { selectedSourceUrl: currentSourceUrl, showUnreadOnly: currentUnreadOnly, sortOrder: currentSortOrder } =
          filterParamsRef.current;
        setArticles((current) => {
          if (current.some((article) => article.id === articleId)) {
            // 一覧に残っている場合（全記事表示モード等）は isRead だけ戻す
            return current.map((article) =>
              article.id === articleId ? { ...article, isRead: false } : article,
            );
          }
          // 未読のみモードで楽観的に削除済みの場合のみ、元の位置に戻す。
          // リクエスト中にフィルタ（ソース切替・未読のみトグル等）が変わっていたら
          // 現在の一覧に属さない記事なので、再挿入しない。
          const belongsToCurrentFilter =
            (currentSourceUrl === undefined || currentSourceUrl === target.siteUrl) &&
            (!currentUnreadOnly || !target.isRead);
          if (!belongsToCurrentFilter) {
            return current;
          }
          const previousIndex = previousArticles.findIndex((article) => article.id === articleId);
          if (previousIndex === -1) {
            return current;
          }
          const restored = { ...previousArticles[previousIndex]!, isRead: false };
          // 現在の並び順（古い順/新しい順）に沿った位置に再挿入する。
          // リクエスト中に並び順が変わっていた場合、スナップショット上の
          // 位置は現在のリストと整合しないため。
          const targetKey = target.publishedAt || target.createdAt;
          const insertIndex = current.findIndex((article) => {
            const articleKey = article.publishedAt || article.createdAt;
            return currentSortOrder === 'asc' ? targetKey < articleKey : targetKey > articleKey;
          });
          const next = [...current];
          next.splice(insertIndex === -1 ? next.length : insertIndex, 0, restored);
          return next;
        });
        sources.restoreSources(previousSources);
        showReadStateStatus({
          kind: 'error',
          message: normalizeError(error, '既読状態の更新に失敗しました。'),
        });
      } finally {
        inFlightReadsRef.current.delete(articleId);
      }
    },
    [articles, filterParamsRef, setArticles, showReadStateStatus, showUnreadOnly, sources],
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

  const showAllSelected = selectedSourceUrl === undefined;
  const showLoadMoreButton = hasMore;
  const totalUnreadCount = useMemo(
    () => sources.sources.reduce((sum, source) => sum + source.unreadCount, 0),
    [sources.sources],
  );

  const displayedStatus: Status | null =
    readStateStatus ?? subscriptions.status ?? sync.status ?? articlesStatus ?? sources.status;

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
                <DropdownMenuTrigger render={<Button variant="outline" size="sm" aria-label={`並び替え（現在: ${sortOrder === 'asc' ? '古い順' : '新しい順'}）`} />}>
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
                aria-label="同期"
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
          </div>
        </header>

        <div className="flex flex-col md:flex-row flex-1 overflow-hidden">
          <aside className="hidden md:block w-80 shrink-0 border-r bg-background/80 backdrop-blur-md">
            <SourceManager
              onAddSubscription={handleAddSubscription}
              onRemoveSubscription={handleRemoveSubscription}
              sources={sources.sources}
              isLoading={sources.isLoading}
              onSelectSource={handleSelectSource}
              selectedSourceUrl={selectedSourceUrl}
            />
          </aside>

          <main id="content" tabIndex={-1} className="relative flex-1 min-h-0 overflow-y-auto overscroll-contain">
            <div className="p-4 md:p-6">
              {displayedStatus && <StatusAlert status={displayedStatus} />}

              <div className="grid gap-4">
                {isLoadingArticles && articles.length === 0 ? (
                  <>
                    <ArticleCardSkeleton />
                    <ArticleCardSkeleton />
                    <ArticleCardSkeleton />
                  </>
                ) : (articles.length === 0 ? (
                  <Empty>
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <Inbox />
                      </EmptyMedia>
                      <EmptyTitle>
                        {showAllSelected
                          ? '記事がまだありません'
                          : '選択したソースの記事がありません'}
                      </EmptyTitle>
                      <EmptyDescription>
                        RSSフィードを追加して記事を取得しましょう
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : (
                  articles.map((article) => (
                    <ArticleCard
                      key={article.id}
                      article={article}
                      onMarkAsRead={(id) => void handleMarkAsRead(id)}
                    />
                  ))
                ))}
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
