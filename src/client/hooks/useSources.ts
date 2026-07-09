import { useQuery } from '@tanstack/react-query';

import type { Source } from '../types.js';
import { normalizeError } from '../utils/status.js';
import type { Status } from '../utils/status.js';

const SOURCES_QUERY_KEY = ['sources'] as const;
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
  isLoading: boolean;
  sources: Source[];
  reload: () => Promise<void>;
  status: Status | null;
}

export function useSources(): UseSourcesResult {
  const query = useQuery({
    queryKey: SOURCES_QUERY_KEY,
    queryFn: fetchSources,
  });

  const status: Status | null = query.isError
    ? { kind: 'error', message: normalizeError(query.error, SOURCES_ERROR_MESSAGE) }
    : null;

  return {
    isLoading: query.isLoading,
    reload: () => query.refetch().then(() => undefined),
    sources: query.data ?? [],
    status,
  };
}
