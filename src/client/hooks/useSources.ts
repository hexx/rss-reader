import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { Source } from '../types.js';
import { normalizeError } from '../utils/status.js';
import type { Status } from '../utils/status.js';

export const SOURCES_QUERY_KEY = ['sources'] as const;
const SOURCES_ERROR_MESSAGE = '購読ソースの読み込みに失敗しました。';

async function fetchSources(): Promise<Source[]> {
  const response = await fetch('/api/sources');
  if (!response.ok) {
    throw new Error(SOURCES_ERROR_MESSAGE);
  }
  const payload = (await response.json()) as { sources?: Source[] };
  return Array.isArray(payload.sources) ? payload.sources : [];
}

interface UseSourcesResult {
  /** 指定ソースの未読数を楽観的に -1 し、ロールバック用のスナップショットを返す。 */
  decrementUnreadCount: (siteUrl: string) => Source[] | undefined;
  isLoading: boolean;
  reload: () => Promise<void>;
  /** 楽観更新前のスナップショットでキャッシュを復元する。 */
  restoreSources: (snapshot: Source[] | undefined) => void;
  sources: Source[];
  status: Status | null;
}

export function useSources(): UseSourcesResult {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryFn: fetchSources,
    queryKey: SOURCES_QUERY_KEY,
  });

  const reload = useCallback((): Promise<void> => {
    return query.refetch().then(() => {});
  }, [query]);

  const decrementUnreadCount = useCallback(
    (siteUrl: string): Source[] | undefined => {
      const snapshot = queryClient.getQueryData<Source[]>(SOURCES_QUERY_KEY);
      if (snapshot) {
        queryClient.setQueryData<Source[]>(
          SOURCES_QUERY_KEY,
          snapshot.map((source) =>
            source.siteUrl === siteUrl
              ? { ...source, unreadCount: Math.max(0, source.unreadCount - 1) }
              : source,
          ),
        );
      }
      return snapshot;
    },
    [queryClient],
  );

  const restoreSources = useCallback(
    (snapshot: Source[] | undefined): void => {
      if (snapshot) {
        queryClient.setQueryData<Source[]>(SOURCES_QUERY_KEY, snapshot);
      }
    },
    [queryClient],
  );

  const status: Status | null = query.isError
    ? { kind: 'error', message: normalizeError(query.error, SOURCES_ERROR_MESSAGE) }
    : null;

  // isLoading には isFetching ではなく isPending を使う。
  // 背景 refetch 中は旧データを表示し続け、スケルトン置換による点滅を防ぐ（ADR 0007）。
  return {
    decrementUnreadCount,
    isLoading: query.isPending,
    reload,
    restoreSources,
    sources: query.data ?? [],
    status,
  };
}
