import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import type { Article, ArticleSortDirection } from '../types.js';
import { ARTICLE_PAGE_SIZE, buildArticlesUrl, mergeLoadedArticles } from '../articlePagination.js';
import { normalizeError } from '../utils/status.js';
import type { Status } from '../utils/status.js';
import { useLatestRef } from './useLatestRef.js';

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

export function useArticles({
  selectedSourceUrl,
  showUnreadOnly,
  sortOrder,
}: UseArticlesParams): UseArticlesResult {
  const [articles, setArticles] = useState<Article[]>([]);
  const [offset, setOffset] = useState(0);
  const [reloadToken, setReloadToken] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);

  // 最新の入力パラメータを ref 経由で参照することで、loadArticles のクロージャ問題を回避する。
  const paramsRef = useLatestRef({ selectedSourceUrl, showUnreadOnly, sortOrder });
  const requestIdRef = useRef(0);

  const refresh = useCallback(() => {
    setOffset(0);
    setHasMore(true);
    setReloadToken((token) => token + 1);
  }, []);

  const loadMore = useCallback(() => {
    setOffset((current) => current + ARTICLE_PAGE_SIZE);
  }, []);

  const clearStatus = useCallback(() => setStatus(null), []);

  useEffect(() => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const isFirstPage = offset === 0;
    const { selectedSourceUrl: sourceUrl, showUnreadOnly: unreadOnly, sortOrder: sort } = paramsRef.current;

    setIsLoading(true);
    setStatus({
      kind: 'loading',
      message: isFirstPage
        ? (unreadOnly
          ? '未読記事を読み込み中...'
          : '記事を読み込み中...')
        : 'さらに記事を読み込み中...',
    });

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
          setIsLoading(false);
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }, [offset, reloadToken, paramsRef]);

  return {
    articles,
    clearStatus,
    hasMore,
    isLoading,
    loadMore,
    refresh,
    setArticles,
    status,
  };
}
