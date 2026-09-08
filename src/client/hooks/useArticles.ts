import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import { ARTICLE_PAGE_SIZE, buildArticlesUrl, mergeLoadedArticles } from '../articlePagination.js';
import type { Article, ArticleSortDirection } from '../types.js';
import { normalizeError } from '../utils/status.js';
import type { Status } from '../utils/status.js';

interface UseArticlesParams {
  selectedSourceUrl: string | undefined;
  showUnreadOnly: boolean;
  sortOrder: ArticleSortDirection;
}

interface UseArticlesResult {
  articles: Article[];
  hasMore: boolean;
  isLoading: boolean;
  loadMore: () => void;
  refresh: () => void;
  setArticles: Dispatch<SetStateAction<Article[]>>;
  status: Status | null;
  clearStatus: () => void;
}

/** 初回ページ（offset = 0）のローディング文言。 */
function firstPageLoadingStatus(unreadOnly: boolean): Status {
  return {
    kind: 'loading',
    message: unreadOnly ? '未読記事を読み込み中...' : '記事を読み込み中...',
  };
}

/** offset に応じたローディング文言（レンダー時導出用）。 */
function loadingStatus(offset: number, unreadOnly: boolean): Status {
  return offset === 0
    ? firstPageLoadingStatus(unreadOnly)
    : { kind: 'loading', message: 'さらに記事を読み込み中...' };
}

export function useArticles({
  selectedSourceUrl,
  showUnreadOnly,
  sortOrder,
}: UseArticlesParams): UseArticlesResult {
  const [articles, setArticles] = useState<Article[]>([]);
  const [offset, setOffset] = useState(0);
  const [reloadToken, setReloadToken] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  // 初回読み込みはマウント時に開始されるため、初期状態からローディングとする。
  const [isLoading, setIsLoading] = useState(true);
  // 完了（success / error / null）のみ保持する。ローディング文言はレンダー時に offset と
  // showUnreadOnly から導出する（effect 内での同期 setState を避け、cascading render を防ぐ）。
  const [status, setStatus] = useState<Status | null>(null);

  const requestIdRef = useRef(0);
  // リクエスト進行中フラグ（loadMore の二重発火でページが飛ばないようにする）
  const isLoadingRef = useRef(false);

  // effect から最新のパラメータを参照するための Effect Event。deps には含めない
  // （パラメータ変更は必ず refresh() 経由で reloadToken が bump されて反映される設計）。
  const getLatestParams = useEffectEvent(() => ({
    selectedSourceUrl,
    showUnreadOnly,
    sortOrder,
  }));

  const refresh = useCallback(() => {
    // ローディング遷移はイベントハンドラで行う（effect 内での同期 setState は cascading render の原因になる）。
    // 文言はレンダー時に導出されるため、ここでは状態の切り替えのみ行う。
    setIsLoading(true);
    isLoadingRef.current = true;
    setOffset(0);
    setHasMore(true);
    setReloadToken((token) => token + 1);
  }, []);

  const loadMore = useCallback(() => {
    if (isLoadingRef.current) {
      return;
    }
    // 連続で呼ばれても二重発火しないよう、offset 変更のコミット前の窓を塞ぐ目的で同期的にアームする。
    isLoadingRef.current = true;
    setIsLoading(true);
    setOffset((current) => current + ARTICLE_PAGE_SIZE);
  }, []);

  const clearStatus = useCallback(() => setStatus(null), []);

  // ローディング中は文言を導出し、それ以外は state の完了結果を表示する。
  const displayedStatus: Status | null = isLoading ? loadingStatus(offset, showUnreadOnly) : status;

  useEffect(() => {
    // reloadToken は refresh の強制再取得トリガー。リクエスト ID に世代（reloadToken）を織り込むことで、
    // refresh 前の古い世代のレスポンスが新しい世代の結果を上書きしないようにする
    // （連番だけでも古いレスポンスは破棄されるが、世代を足すことで requestId の単調性を保つ）。
    const requestId = requestIdRef.current + reloadToken + 1;
    requestIdRef.current = requestId;
    const isFirstPage = offset === 0;
    const { selectedSourceUrl: sourceUrl, showUnreadOnly: unreadOnly, sortOrder: sort } = getLatestParams();

    const controller = new AbortController();

    (async () => {
      try {
        const response = await fetch(
          buildArticlesUrl({
            limit: ARTICLE_PAGE_SIZE,
            offset,
            sort,
            sourceUrl,
            unreadOnly,
          }),
          { signal: controller.signal },
        );
        if (!response.ok) {
          throw new Error('記事の読み込みに失敗しました。');
        }
        const payload = (await response.json()) as { articles?: Article[] };
        const nextArticles = Array.isArray(payload.articles) ? payload.articles : [];

        if (requestIdRef.current !== requestId) {
          return;
        }

        setArticles((current) => mergeLoadedArticles(current, nextArticles, offset));
        setHasMore(nextArticles.length === ARTICLE_PAGE_SIZE);
        setStatus({
          kind: 'success',
          message:
            nextArticles.length === 0
              ? isFirstPage
                ? unreadOnly
                  ? '未読記事がありません。'
                  : '記事がまだありません。'
                : 'これ以上の記事はありません。'
              : isFirstPage
                ? unreadOnly
                  ? '未読記事を表示しています。'
                  : sourceUrl
                    ? '選択したソースの記事を表示しています。'
                    : '最新記事を表示しています。'
                : 'さらに記事を読み込みました。',
        });
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        if (requestIdRef.current !== requestId) {
          return;
        }
        setStatus({ kind: 'error', message: normalizeError(error, '記事の読み込みに失敗しました。') });
      } finally {
        if (requestIdRef.current === requestId) {
          isLoadingRef.current = false;
          setIsLoading(false);
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }, [offset, reloadToken]);

  return {
    articles,
    clearStatus,
    hasMore,
    isLoading,
    loadMore,
    refresh,
    setArticles,
    status: displayedStatus,
  };
}
